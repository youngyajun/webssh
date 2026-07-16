package com.webssh.ssh;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.Session;
import com.webssh.config.WebSshProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * SSH 服务
 * 管理 SSH 连接的生命周期
 *
 * @author webssh
 */
@Service
public class SshService {
    private static final Logger log = LoggerFactory.getLogger(SshService.class);

    /** 匹配前端 resize 消息：{"type":"resize","cols":N,"rows":N} */
    private static final Pattern RESIZE_PATTERN =
            Pattern.compile("\"type\"\\s*:\\s*\"resize\".*?\"cols\"\\s*:\\s*(\\d+).*?\"rows\"\\s*:\\s*(\\d+)",
                    Pattern.CASE_INSENSITIVE);

    /** 每个 WebSocket 会话的命令行缓冲区，用于检测高风险命令 */
    private final ConcurrentHashMap<String, StringBuilder> commandBuffers = new ConcurrentHashMap<>();

    /** 已编译的高风险命令正则（延迟初始化） */
    private volatile List<Pattern> compiledHighRiskPatterns;

    @Autowired
    private SshConnectionFactory connectionFactory;

    @Autowired
    private SshSessionHolder sessionHolder;

    @Autowired
    private WebSshProperties properties;

    /**
     * 初始化 SSH 连接并关联到 WebSocket 会话
     * 凭据来源优先级：WebSocket 会话属性（界面输入） > 主机配置（配置文件）
     */
    public void initConnection(WebSocketSession webSocketSession, String hostName) throws Exception {
        // 查找主机配置
        WebSshProperties.Host host = findHost(hostName);
        if (host == null) {
            throw new IllegalArgumentException("未找到主机配置: " + hostName);
        }

        // 从 WebSocket 握手属性中获取界面输入的凭据（可能为 null）
        String username = (String) webSocketSession.getAttributes().get("sshUsername");
        String password = (String) webSocketSession.getAttributes().get("sshPassword");

        // 创建 SSH session
        Session session = connectionFactory.createSession(host, username, password);
        sessionHolder.putSession(webSocketSession.getId(), session);

        // 创建 shell channel
        ChannelShell channel = (ChannelShell) session.openChannel("shell");
        // 设置终端类型
        channel.setPtyType(properties.getTerminalType());
        channel.setEnv("LANG", properties.getCharset());

        // 在 connect 之前设置初始 PTY 尺寸，避免 PTY 默认 80x24 导致 vim 等全屏程序
        // 在前端 resize 消息到达前以错误尺寸启动（表现为内容只填充左上角小块区域）
        int[] initialSize = resolveInitialPtySize(webSocketSession);
        int initCols = initialSize[0];
        int initRows = initialSize[1];
        int cellWidth = 8;
        int cellHeight = 16;
        channel.setPtySize(initCols, initRows, initCols * cellWidth, initRows * cellHeight);

        channel.connect(properties.getTimeout());

        sessionHolder.putChannel(webSocketSession.getId(), channel);

        log.info("WebSSH: 初始化连接成功 sessionId={}, host={}, ptySize={}x{}", webSocketSession.getId(), hostName, initCols, initRows);
    }

    /**
     * 从 WebSocket 握手属性中解析初始 PTY 尺寸
     * 前端在 WebSocket 握手前已通过 fit 计算出 cols/rows，并以 URL 参数传入。
     * 解析失败或未提供时回退到默认值 80x24。
     *
     * @return int[2]，下标 0 为 cols，下标 1 为 rows
     */
    private int[] resolveInitialPtySize(WebSocketSession webSocketSession) {
        int cols = 80;
        int rows = 24;
        Object colsAttr = webSocketSession.getAttributes().get("initialCols");
        Object rowsAttr = webSocketSession.getAttributes().get("initialRows");
        if (colsAttr instanceof String) {
            try {
                int parsed = Integer.parseInt((String) colsAttr);
                if (parsed > 0 && parsed <= 1024) {
                    cols = parsed;
                }
            } catch (NumberFormatException ignored) {
                // 解析失败保持默认值
            }
        }
        if (rowsAttr instanceof String) {
            try {
                int parsed = Integer.parseInt((String) rowsAttr);
                if (parsed > 0 && parsed <= 1024) {
                    rows = parsed;
                }
            } catch (NumberFormatException ignored) {
                // 解析失败保持默认值
            }
        }
        return new int[]{cols, rows};
    }

    /**
     * 处理来自前端的输入
     * 支持两种消息：
     * 1. 普通终端输入：直接写入 SSH 通道
     * 2. resize 消息：JSON 格式 {"type":"resize","cols":N,"rows":N}，调整伪终端尺寸
     *
     * 同时在此方法中拦截高风险命令：当检测到用户输入回车时，
     * 检查当前命令行是否匹配高风险命令正则列表，命中则拒绝执行并给出警告。
     */
    public void recvHandle(WebSocketSession webSocketSession, String input) throws Exception {
        // 优先判断是否为终端 resize 消息
        if (input != null && input.startsWith("{") && input.contains("\"resize\"")) {
            if (handleResize(webSocketSession, input)) {
                return;
            }
            // 解析失败则按普通输入处理
        }

        Channel channel = sessionHolder.getChannel(webSocketSession.getId());
        if (channel == null) {
            throw new IllegalStateException("SSH通道不存在");
        }

        // 高风险命令拦截
        List<Pattern> riskPatterns = getHighRiskPatterns();
        if (!riskPatterns.isEmpty()) {
            interceptHighRiskCommand(webSocketSession, input, channel, riskPatterns);
            return;
        }

        // 无高风险命令配置时直接透传
        OutputStream outputStream = channel.getOutputStream();
        outputStream.write(input.getBytes(properties.getCharset()));
        outputStream.flush();
    }

    /**
     * 逐字符处理输入流，跟踪命令行缓冲区，拦截高风险命令。
     * 当用户按下回车（\r / \n）时检查缓冲区是否命中黑名单，
     * 命中则向 SSH 发送 Ctrl+U 清空行缓冲区，并通过 WebSocket 发送警告文本。
     */
    private void interceptHighRiskCommand(WebSocketSession webSocketSession, String input,
                                          Channel channel, List<Pattern> riskPatterns) throws Exception {
        String sessionId = webSocketSession.getId();
        StringBuilder buf = commandBuffers.computeIfAbsent(sessionId, k -> new StringBuilder());
        OutputStream out = channel.getOutputStream();

        for (int i = 0; i < input.length(); i++) {
            char c = input.charAt(i);

            if (c == '\r' || c == '\n') {
                String cmd = buf.toString().trim();
                buf.setLength(0);

                if (isHighRiskCommand(cmd, riskPatterns)) {
                    // 清除shell输入缓冲（Ctrl+U），不发送回车
                    out.write(new byte[]{0x15});
                    out.flush();
                    // 通过 WebSocket 直接发送警告
                    if (webSocketSession.isOpen()) {
                        webSocketSession.sendMessage(new TextMessage(
                                "\r\n\u001b[31m[WebSSH 安全防护] 高风险命令已拦截: " + cmd + "\u001b[0m\r\n"));
                    }
                    log.warn("WebSSH: 拦截高风险命令 sessionId={}, command={}", sessionId, cmd);
                    continue; // 跳过发送 \r
                }
                // 安全命令，发送回车
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            } else if (c == 0x7F || c == '\b') {
                // 退格：从缓冲区移除最后一个字符
                if (buf.length() > 0) {
                    buf.setLength(buf.length() - 1);
                }
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            } else if (c == 0x1B) {
                // ESC（方向键等 ANSI 转义序列起始）：清空缓冲区（无法可靠跟踪光标位置）
                buf.setLength(0);
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            } else if (c == 0x03 || c == 0x04) {
                // Ctrl+C / Ctrl+D：中断当前输入
                buf.setLength(0);
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            } else if (c >= 0x20 && c <= 0x7E || c == '\t') {
                // 可打印 ASCII 字符 + Tab
                buf.append(c);
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            } else {
                // 其他控制字符直接透传
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            }
        }
        out.flush();
    }

    /**
     * 检查命令是否匹配高风险模式
     */
    private boolean isHighRiskCommand(String command, List<Pattern> patterns) {
        if (command.isEmpty()) {
            return false;
        }
        for (Pattern pattern : patterns) {
            if (pattern.matcher(command).find()) {
                return true;
            }
        }
        return false;
    }

    /**
     * 获取已编译的高风险命令正则列表（延迟初始化）
     */
    private List<Pattern> getHighRiskPatterns() {
        if (compiledHighRiskPatterns == null) {
            synchronized (this) {
                if (compiledHighRiskPatterns == null) {
                    List<Pattern> patterns = new ArrayList<>();
                    List<String> commands = properties.getHighRiskCommands();
                    if (commands != null) {
                        for (String cmd : commands) {
                            if (cmd != null && !cmd.trim().isEmpty()) {
                                try {
                                    patterns.add(Pattern.compile(cmd.trim(), Pattern.CASE_INSENSITIVE));
                                } catch (Exception e) {
                                    log.warn("WebSSH: 高风险命令正则编译失败: {}", cmd);
                                }
                            }
                        }
                    }
                    compiledHighRiskPatterns = patterns;
                }
            }
        }
        return compiledHighRiskPatterns;
    }

    /**
     * 清除指定会话的命令缓冲区（当 WebSocket 断开时调用）
     */
    public void clearCommandBuffer(String sessionId) {
        commandBuffers.remove(sessionId);
    }

    /**
     * 解析 resize 消息并调整 SSH 伪终端尺寸
     * 消息格式：{"type":"resize","cols":N,"rows":N}
     *
     * @param webSocketSession WebSocket 会话
     * @param input            JSON 消息内容
     * @return true 表示成功识别并处理，false 表示非 resize 消息或解析失败
     */
    private boolean handleResize(WebSocketSession webSocketSession, String input) {
        Matcher matcher = RESIZE_PATTERN.matcher(input);
        if (!matcher.find()) {
            return false;
        }
        try {
            int cols = Integer.parseInt(matcher.group(1));
            int rows = Integer.parseInt(matcher.group(2));
            if (cols <= 0 || rows <= 0) {
                return false;
            }
            Channel channel = sessionHolder.getChannel(webSocketSession.getId());
            if (channel == null) {
                return true;
            }
            // 调整 PTY 尺寸：cols/rows 为字符行列数，wp/hp 为像素宽高（按字符单元估算）
            // setPtySize 定义在 ChannelShell 上，需做类型转换
            if (!(channel instanceof ChannelShell)) {
                return true;
            }
            int cellWidth = 8;
            int cellHeight = 16;
            ((ChannelShell) channel).setPtySize(cols, rows, cols * cellWidth, rows * cellHeight);
            log.debug("WebSSH: 终端尺寸调整 sessionId={} cols={} rows={}", webSocketSession.getId(), cols, rows);
            return true;
        } catch (Exception e) {
            log.debug("WebSSH: resize 消息解析失败，按普通输入处理: {}", input);
            return false;
        }
    }

    /**
     * 将 SSH 输出回传给前端
     * 在 WebSocket 处理器中由后台线程持续调用
     */
    public void sendHandle(WebSocketSession webSocketSession) throws Exception {
        Channel channel = sessionHolder.getChannel(webSocketSession.getId());
        if (channel == null) {
            return;
        }
        InputStream inputStream = channel.getInputStream();
        byte[] buffer = new byte[1024];
        int i;
        while ((i = inputStream.read(buffer)) != -1) {
            if (webSocketSession.isOpen()) {
                byte[] bytes = new byte[i];
                System.arraycopy(buffer, 0, bytes, 0, i);
                webSocketSession.sendMessage(new org.springframework.web.socket.TextMessage(new String(bytes, properties.getCharset())));
            } else {
                break;
            }
        }
    }

    /**
     * 执行单条命令（非交互式）
     */
    public String executeCommand(String sessionId, String command) throws Exception {
        return sessionHolder.executeCommand(sessionId, command);
    }

    /**
     * 获取 SFTP Channel
     */
    public com.jcraft.jsch.ChannelSftp getSftpChannel(String sessionId) throws Exception {
        return sessionHolder.getSftpChannel(sessionId);
    }

    /**
     * 关闭 SSH 连接
     */
    public void closeConnection(WebSocketSession webSocketSession) {
        commandBuffers.remove(webSocketSession.getId());
        sessionHolder.closeSession(webSocketSession.getId());
    }

    /**
     * 为文件管理创建独立的 SSH 会话（不依赖 WebSocket）
     * 与终端的 shell 会话解耦，避免 sessionId 关联与并发竞态问题
     *
     * @param hostName 主机名称
     * @return 文件会话 sessionId
     */
    public String createFileSession(String hostName) throws Exception {
        return createFileSession(hostName, null, null);
    }

    /**
     * 为文件管理创建独立的 SSH 会话（不依赖 WebSocket）
     * 凭据来源优先级：外部传入（界面输入） > 主机配置（配置文件）
     *
     * @param hostName         主机名称
     * @param overrideUsername 外部传入的用户名（界面输入），为空则回退到配置
     * @param overridePassword 外部传入的密码（界面输入），为空则回退到配置
     * @return 文件会话 sessionId
     */
    public String createFileSession(String hostName, String overrideUsername,
                                    String overridePassword) throws Exception {
        WebSshProperties.Host host = findHost(hostName);
        if (host == null) {
            throw new IllegalArgumentException("未找到主机配置: " + hostName);
        }
        Session session = connectionFactory.createSession(host, overrideUsername, overridePassword);
        String sessionId = "file-" + java.util.UUID.randomUUID();
        sessionHolder.putSession(sessionId, session);
        log.info("WebSSH: 文件会话建立成功 sessionId={}, host={}", sessionId, hostName);
        return sessionId;
    }

    /**
     * 关闭文件管理用的 SSH 会话
     */
    public void closeFileSession(String sessionId) {
        if (sessionId != null && !sessionId.isEmpty()) {
            sessionHolder.closeSession(sessionId);
        }
    }

    /**
     * 解析 cd 命令后的真实工作目录
     * 在独立 exec 进程中按 base -> target 顺序执行 cd，再 pwd 取得绝对路径，
     * 用于终端与文件浏览器的路径同步
     *
     * @param sessionId 文件会话 sessionId
     * @param base      当前终端工作目录（相对路径计算基准），可为空
     * @param target    cd 的参数（如 /usr/local、..、~、subdir），可为空表示回到 home
     * @return 真实绝对路径（首行）
     */
    public String resolveCwd(String sessionId, String base, String target) throws Exception {
        StringBuilder cmd = new StringBuilder();
        if (base != null && !base.isEmpty()) {
            // base 是绝对路径，用单引号包裹防注入
            cmd.append("cd '").append(base.replace("'", "'\\''")).append("' && ");
        }
        if (target == null || target.isEmpty()) {
            cmd.append("cd ~ && pwd");
        } else {
            // target 已由上层正则校验仅含路径安全字符，不引号以支持 ~ 展开
            cmd.append("cd ").append(target).append(" && pwd");
        }
        String output = sessionHolder.executeCommand(sessionId, cmd.toString());
        if (output == null) {
            return "";
        }
        String trimmed = output.trim();
        int nl = trimmed.indexOf('\n');
        return nl >= 0 ? trimmed.substring(0, nl) : trimmed;
    }

    /**
     * 获取 JSch Session（用于目录下载等需要直接操作底层 Channel 的场景）
     */
    public Session getJschSession(String sessionId) {
        return sessionHolder.getJschSession(sessionId);
    }

    /**
     * 获取所有主机配置名称
     */
    public java.util.List<String> getHostNames() {
        java.util.List<String> names = new java.util.ArrayList<>();
        for (WebSshProperties.Host host : properties.getHosts()) {
            names.add(host.getName() != null ? host.getName() : host.getHost());
        }
        return names;
    }

    /**
     * 获取所有主机信息（含是否需要在界面输入凭据）
     *
     * @return 主机信息列表，每项包含 name 和 needCredentials
     */
    public java.util.List<java.util.Map<String, Object>> getHostInfos() {
        java.util.List<java.util.Map<String, Object>> list = new java.util.ArrayList<>();
        for (WebSshProperties.Host host : properties.getHosts()) {
            java.util.Map<String, Object> info = new java.util.HashMap<>();
            info.put("name", host.getName() != null ? host.getName() : host.getHost());
            info.put("host", host.getHost());
            info.put("port", host.getPort());
            info.put("username", host.getUsername());
            info.put("needCredentials", needsCredentials(host));
            list.add(info);
        }
        return list;
    }

    /**
     * 判断主机是否需要在界面输入凭据
     * 配置了私钥 或 同时配置了用户名和密码 时不需要
     */
    private boolean needsCredentials(WebSshProperties.Host host) {
        boolean hasPrivateKey = host.getPrivateKey() != null && !host.getPrivateKey().isEmpty();
        boolean hasUsername = host.getUsername() != null && !host.getUsername().isEmpty();
        boolean hasPassword = host.getPassword() != null && !host.getPassword().isEmpty();
        return !hasPrivateKey && (!hasUsername || !hasPassword);
    }

    /**
     * 查找主机配置
     * 先在配置文件中按名称查找；若未找到，则将输入作为自定义主机 IP/域名处理，
     * 支持 host:port 格式（如 192.168.1.1:2222），端口默认 22。
     * 自定义主机不预配凭据，由界面输入。
     */
    private WebSshProperties.Host findHost(String hostName) {
        for (WebSshProperties.Host host : properties.getHosts()) {
            String name = host.getName() != null ? host.getName() : host.getHost();
            if (name.equals(hostName)) {
                return host;
            }
        }
        // 未在配置中找到，作为自定义主机处理（支持 host:port 格式）
        if (hostName != null && !hostName.isEmpty()) {
            WebSshProperties.Host custom = new WebSshProperties.Host();
            String host = hostName;
            int port = 22;
            int colonIdx = hostName.lastIndexOf(':');
            if (colonIdx > 0) {
                String hostPart = hostName.substring(0, colonIdx);
                String portPart = hostName.substring(colonIdx + 1);
                // 仅当 host 部分不含冒号（非 IPv6）时才尝试解析端口
                if (!hostPart.contains(":")) {
                    try {
                        int parsedPort = Integer.parseInt(portPart.trim());
                        if (parsedPort > 0 && parsedPort <= 65535) {
                            port = parsedPort;
                            host = hostPart.trim();
                        }
                    } catch (NumberFormatException ignored) {
                        // 不是端口号，整体作为 host 处理
                    }
                }
            }
            custom.setName(hostName);
            custom.setHost(host);
            custom.setPort(port);
            log.info("WebSSH: 使用自定义主机 host={}, port={}", host, port);
            return custom;
        }
        return null;
    }
}
