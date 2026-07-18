package com.webssh.ssh;

import com.pty4j.PtyProcess;
import com.pty4j.PtyProcessBuilder;
import com.pty4j.WinSize;
import com.webssh.config.WebSshProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;

import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 本地 PTY 服务
 * 用于 type=local 的主机配置：直接在本机启动 PTY shell，绕过 SSH 协议。
 * 适用场景：webssh 与目标 Linux 服务器同机部署，且不希望暴露或使用 SSH 凭据。
 *
 * 终端交互、ZMODEM（rz/sz）、resize、高风险命令拦截均与 {@link SshService} 行为对齐。
 *
 * @author webssh
 */
@Service
public class LocalPtyService {
    private static final Logger log = LoggerFactory.getLogger(LocalPtyService.class);

    /** 匹配前端 resize 消息：{"type":"resize","cols":N,"rows":N} */
    private static final Pattern RESIZE_PATTERN =
            Pattern.compile("\"type\"\\s*:\\s*\"resize\".*?\"cols\"\\s*:\\s*(\\d+).*?\"rows\"\\s*:\\s*(\\d+)",
                    Pattern.CASE_INSENSITIVE);

    /** 每个 WebSocket 会话对应的本地 PTY 进程 */
    private final Map<String, PtyProcess> ptyMap = new ConcurrentHashMap<>();

    /** 每个 WebSocket 会话的命令行缓冲区，用于检测高风险命令 */
    private final ConcurrentHashMap<String, StringBuilder> commandBuffers = new ConcurrentHashMap<>();

    /** 已编译的高风险命令正则（延迟初始化） */
    private volatile List<Pattern> compiledHighRiskPatterns;

    @Autowired
    private WebSshProperties properties;

    /**
     * 判断指定主机名是否为本地 PTY 模式
     */
    public boolean isLocalHost(String hostName) {
        WebSshProperties.Host host = findHost(hostName);
        return host != null && host.isLocal();
    }

    /**
     * 初始化本地 PTY 连接
     * 在本机直接启动一个登录 shell（bash/sh），不经过 SSH 协议。
     */
    public void initConnection(WebSocketSession webSocketSession, String hostName) throws Exception {
        WebSshProperties.Host host = findHost(hostName);
        if (host == null) {
            throw new IllegalArgumentException("未找到主机配置: " + hostName);
        }
        if (!host.isLocal()) {
            throw new IllegalStateException("主机不是本地 PTY 模式: " + hostName);
        }

        String osName = System.getProperty("os.name", "");
        if (osName.toLowerCase().contains("windows")) {
            throw new UnsupportedOperationException(
                    "本地 PTY 模式暂不支持 Windows（请使用 SSH 模式连接本机）");
        }

        String[] command = resolveShellCommand();
        Map<String, String> env = new HashMap<>(System.getenv());
        env.put("TERM", properties.getTerminalType());
        env.put("LANG", properties.getCharset());

        int[] initialSize = resolveInitialPtySize(webSocketSession);
        int initCols = initialSize[0];
        int initRows = initialSize[1];

        PtyProcessBuilder builder = new PtyProcessBuilder()
                .setCommand(command)
                .setEnvironment(env)
                .setInitialColumns(initCols)
                .setInitialRows(initRows)
                .setRedirectErrorStream(true)
                .setDirectory(System.getProperty("user.home", "."));

        PtyProcess pty = builder.start();
        ptyMap.put(webSocketSession.getId(), pty);

        log.info("WebSSH: 本地 PTY 启动成功 sessionId={}, shell={}, ptySize={}x{}",
                webSocketSession.getId(), command[0], initCols, initRows);
    }

    /**
     * 解析默认 shell 命令
     * 优先使用 SHELL 环境变量，其次尝试 /bin/bash，最后回退 /bin/sh
     * 使用 "-l"（登录 shell）以加载 /etc/profile 与 ~/.profile，确保 PATH 完整
     */
    private String[] resolveShellCommand() {
        String shell = System.getenv("SHELL");
        if (shell == null || shell.isEmpty()) {
            File bash = new File("/bin/bash");
            if (bash.canExecute()) {
                shell = "/bin/bash";
            } else {
                shell = "/bin/sh";
            }
        }
        return new String[]{shell, "-l"};
    }

    /**
     * 从 WebSocket 握手属性中解析初始 PTY 尺寸（与 SshService 保持一致）
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
            }
        }
        if (rowsAttr instanceof String) {
            try {
                int parsed = Integer.parseInt((String) rowsAttr);
                if (parsed > 0 && parsed <= 1024) {
                    rows = parsed;
                }
            } catch (NumberFormatException ignored) {
            }
        }
        return new int[]{cols, rows};
    }

    /**
     * 处理来自前端的文本输入
     * - resize 消息：调整 PTY 尺寸
     * - 普通输入：写入 PTY，并执行高风险命令拦截（与 SshService 行为一致）
     */
    public void recvHandle(WebSocketSession webSocketSession, String input) throws Exception {
        if (input != null && input.startsWith("{") && input.contains("\"resize\"")) {
            if (handleResize(webSocketSession, input)) {
                return;
            }
        }

        PtyProcess pty = ptyMap.get(webSocketSession.getId());
        if (pty == null) {
            throw new IllegalStateException("本地 PTY 不存在");
        }

        List<Pattern> riskPatterns = getHighRiskPatterns();
        if (!riskPatterns.isEmpty()) {
            interceptHighRiskCommand(webSocketSession, input, pty, riskPatterns);
            return;
        }

        OutputStream out = pty.getOutputStream();
        out.write(input.getBytes(properties.getCharset()));
        out.flush();
    }

    /**
     * 逐字符处理输入流，跟踪命令行缓冲区，拦截高风险命令
     * 逻辑与 SshService.interceptHighRiskCommand 完全一致，仅输出目标不同（PtyProcess vs Channel）
     */
    private void interceptHighRiskCommand(WebSocketSession webSocketSession, String input,
                                          PtyProcess pty, List<Pattern> riskPatterns) throws Exception {
        String sessionId = webSocketSession.getId();
        StringBuilder buf = commandBuffers.computeIfAbsent(sessionId, k -> new StringBuilder());
        OutputStream out = pty.getOutputStream();

        for (int i = 0; i < input.length(); i++) {
            char c = input.charAt(i);

            if (c == '\r' || c == '\n') {
                String cmd = buf.toString().trim();
                buf.setLength(0);

                if (isHighRiskCommand(cmd, riskPatterns)) {
                    out.write(new byte[]{0x15});
                    out.flush();
                    if (webSocketSession.isOpen()) {
                        webSocketSession.sendMessage(new TextMessage(
                                "\r\n\u001b[31m[WebSSH 安全防护] 高风险命令已拦截: " + cmd + "\u001b[0m\r\n"));
                    }
                    log.warn("WebSSH: 拦截高风险命令（本地 PTY）sessionId={}, command={}", sessionId, cmd);
                    continue;
                }
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            } else if (c == 0x7F || c == '\b') {
                if (buf.length() > 0) {
                    buf.setLength(buf.length() - 1);
                }
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            } else if (c == 0x1B) {
                buf.setLength(0);
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            } else if (c == 0x03 || c == 0x04) {
                buf.setLength(0);
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            } else if (c >= 0x20 && c <= 0x7E || c == '\t') {
                buf.append(c);
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            } else {
                out.write(String.valueOf(c).getBytes(properties.getCharset()));
            }
        }
        out.flush();
    }

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
     * 解析 resize 消息并调整本地 PTY 尺寸
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
            PtyProcess pty = ptyMap.get(webSocketSession.getId());
            if (pty == null) {
                return true;
            }
            pty.setWinSize(new WinSize(cols, rows));
            log.debug("WebSSH: 终端尺寸调整（本地 PTY）sessionId={} cols={} rows={}",
                    webSocketSession.getId(), cols, rows);
            return true;
        } catch (Exception e) {
            log.debug("WebSSH: resize 消息解析失败，按普通输入处理: {}", input);
            return false;
        }
    }

    /**
     * 将本地 PTY 输出回传给前端
     * 统一以 BinaryMessage 发送原始字节，前端通过 zmodem sentry 分流（与 SshService 行为一致）
     */
    public void sendHandle(WebSocketSession webSocketSession) throws Exception {
        PtyProcess pty = ptyMap.get(webSocketSession.getId());
        if (pty == null) {
            return;
        }
        WebSocketSession asyncSession = new ConcurrentWebSocketSessionDecorator(webSocketSession, 0, 10 * 1024 * 1024);
        InputStream inputStream = pty.getInputStream();
        byte[] buffer = new byte[8192];
        int i;
        while ((i = inputStream.read(buffer)) != -1) {
            if (asyncSession.isOpen()) {
                byte[] bytes = new byte[i];
                System.arraycopy(buffer, 0, bytes, 0, i);
                asyncSession.sendMessage(new BinaryMessage(bytes));
            } else {
                break;
            }
        }
        // read 返回 -1：本地 PTY 进程已退出（如用户输入 exit/logout）。
        // 关闭 WebSocket，使用自定义关闭码 4000 标识"shell 正常退出"，
        // 前端 onclose 据此跳过自动重连（与 xshell 行为一致）。
        // 通过 decorator.close() 关闭可确保已排队的终端输出先发送给前端。
        if (asyncSession.isOpen()) {
            asyncSession.close(new CloseStatus(4000, "shell-exited"));
        }
    }

    /**
     * 处理来自前端的二进制输入（ZMODEM rz 上传场景）
     * 字节直接透传到本地 PTY
     */
    public void recvHandleBinary(WebSocketSession webSocketSession, byte[] bytes) throws Exception {
        PtyProcess pty = ptyMap.get(webSocketSession.getId());
        if (pty == null) {
            throw new IllegalStateException("本地 PTY 不存在");
        }
        if (bytes == null || bytes.length == 0) {
            return;
        }
        OutputStream out = pty.getOutputStream();
        out.write(bytes);
        out.flush();
    }

    /**
     * 关闭本地 PTY 连接
     */
    public void closeConnection(WebSocketSession webSocketSession) {
        commandBuffers.remove(webSocketSession.getId());
        PtyProcess pty = ptyMap.remove(webSocketSession.getId());
        if (pty != null) {
            try {
                pty.destroy();
            } catch (Exception e) {
                log.warn("WebSSH: 关闭本地 PTY 异常: {}", e.getMessage());
            }
            log.info("WebSSH: 本地 PTY 已关闭 {}", webSocketSession.getId());
        }
    }

    /**
     * 查找主机配置（与 SshService.findHost 同语义）
     */
    private WebSshProperties.Host findHost(String hostName) {
        if (hostName == null) {
            return null;
        }
        for (WebSshProperties.Host host : properties.getHosts()) {
            String id = host.getName() != null ? host.getName() : host.getHost();
            if (hostName.equals(id)) {
                return host;
            }
        }
        return null;
    }
}
