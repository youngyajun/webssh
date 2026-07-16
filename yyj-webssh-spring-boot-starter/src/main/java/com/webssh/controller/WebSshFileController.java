package com.webssh.controller;

import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.SftpException;
import com.webssh.ssh.SshService;
import com.webssh.util.RsaUtil;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.*;

/**
 * WebSSH 文件管理控制器
 * 提供文件浏览、预览、下载功能
 *
 * @author webssh
 */
@RestController
@RequestMapping("${webssh.context-path:/webssh}/api")
public class WebSshFileController {
    private static final Logger log = LoggerFactory.getLogger(WebSshFileController.class);

    @Autowired
    private SshService sshService;

    /**
     * 获取主机列表
     */
    @GetMapping("/hosts")
    public Map<String, Object> getHosts() {
        Map<String, Object> result = new HashMap<>();
        result.put("hosts", sshService.getHostNames());
        return result;
    }

    /**
     * 获取主机详细信息（包括是否需要凭据）
     */
    @GetMapping("/hosts/info")
    public Map<String, Object> getHostInfos() {
        Map<String, Object> result = new HashMap<>();
        result.put("code", 200);
        result.put("hosts", sshService.getHostInfos());
        return result;
    }

    /**
     * 建立文件管理用的 SSH 会话（独立于 WebSocket 终端）
     * 多标签页场景下，每个标签页创建独立的文件会话，互不影响
     */
    @PostMapping("/connect")
    public Map<String, Object> connect(@RequestBody Map<String, String> params, HttpSession session) {
        Map<String, Object> result = new HashMap<>();
        String host = params.get("host");
        if (host == null || host.isEmpty()) {
            result.put("code", 400);
            result.put("msg", "host不能为空");
            return result;
        }
        try {
            // 获取可选的用户名和密码参数
            String username = params.get("username");
            String encryptedPassword = params.get("password");
            String keyId = params.get("keyId");

            // 使用 keyId 从 Session 映射表中取出私钥解密密码（与登录流程一致，私钥一次性使用）
            String password = RsaUtil.decryptWithSessionKey(session, encryptedPassword, keyId);

            String sessionId = sshService.createFileSession(host, username, password);
            // 追踪所有文件会话，用于 logout 时统一清理
            // 注意：不再往 HttpSession 写入 fileSessionId 单值，多标签场景下该回退值会过期导致报错
            trackFileSession(session, sessionId);
            result.put("code", 200);
            result.put("msg", "连接成功");
            result.put("sessionId", sessionId);
            result.put("host", host);
        } catch (Exception e) {
            log.error("WebSSH: 建立文件会话失败 host={}", host, e);
            String msg = e.getMessage();
            // 密码解密失败（公钥过期或密文无效）
            if (e instanceof IllegalStateException && msg != null && msg.contains("公钥已过期")) {
                result.put("code", 401);
                result.put("msg", msg);
            }
            // 检测是否为 SSH 认证失败
            else if (msg != null && (msg.contains("Auth fail") || msg.contains("Authentication failed")
                    || (e instanceof com.jcraft.jsch.JSchException))) {
                result.put("code", 401);
                result.put("msg", "SSH 认证失败，用户名或密码错误");
            } else {
                result.put("code", 500);
                result.put("msg", msg);
            }
        }
        return result;
    }

    /**
     * 断开文件管理用的 SSH 会话
     * 通过 sessionId 参数断开指定会话（多标签场景下每个标签页独立管理）
     */
    @PostMapping("/disconnect")
    public Map<String, Object> disconnect(@RequestBody(required = false) Map<String, String> params,
                                          HttpSession session) {
        Map<String, Object> result = new HashMap<>();
        String sessionId = null;
        if (params != null) {
            sessionId = params.get("sessionId");
        }
        if (sessionId != null && !sessionId.isEmpty()) {
            sshService.closeFileSession(sessionId);
            // 从追踪集合中移除
            untrackFileSession(session, sessionId);
        }
        result.put("code", 200);
        result.put("msg", "已断开");
        return result;
    }

    /**
     * 追踪文件会话到 HttpSession（用于 logout 时统一清理）
     */
    @SuppressWarnings("unchecked")
    private void trackFileSession(HttpSession session, String sessionId) {
        Set<String> all = (Set<String>) session.getAttribute("allFileSessions");
        if (all == null) {
            all = Collections.synchronizedSet(new HashSet<>());
            session.setAttribute("allFileSessions", all);
        }
        all.add(sessionId);
    }

    /**
     * 从追踪集合中移除文件会话
     */
    @SuppressWarnings("unchecked")
    private void untrackFileSession(HttpSession session, String sessionId) {
        Set<String> all = (Set<String>) session.getAttribute("allFileSessions");
        if (all != null) {
            all.remove(sessionId);
        }
    }

    /**
     * 关闭并清理 HttpSession 中追踪的所有文件会话（用于 logout）
     */
    @SuppressWarnings("unchecked")
    public static void closeAllFileSessions(HttpSession session, SshService sshService) {
        Set<String> all = (Set<String>) session.getAttribute("allFileSessions");
        if (all != null) {
            for (String sid : all) {
                try {
                    sshService.closeFileSession(sid);
                } catch (Exception ignored) {
                }
            }
            all.clear();
            session.removeAttribute("allFileSessions");
        }
    }

    /**
     * 上传文件到远程服务器
     * 将本地文件通过 SFTP 上传到指定的远程目录
     */
    @PostMapping("/upload")
    public Map<String, Object> uploadFile(@RequestParam("file") MultipartFile file,
                                          @RequestParam("path") String path,
                                          @RequestParam(required = false) String sessionId,
                                          @RequestParam(required = false, defaultValue = "false") boolean overwrite,
                                          HttpSession httpSession) {
        Map<String, Object> result = new HashMap<>();
        ChannelSftp sftp = null;
        try {
            if (sessionId == null || sessionId.isEmpty()) {
                result.put("code", 401);
                result.put("msg", "请先建立SSH连接");
                return result;
            }

            if (file.isEmpty()) {
                result.put("code", 400);
                result.put("msg", "文件为空");
                return result;
            }

            // 获取原始文件名
            String originalFilename = file.getOriginalFilename();
            if (originalFilename == null || originalFilename.isEmpty()) {
                result.put("code", 400);
                result.put("msg", "文件名不能为空");
                return result;
            }
            // 安全处理文件名：只保留文件名部分，去除路径
            int lastSep = originalFilename.lastIndexOf('/');
            if (lastSep < 0) {
                lastSep = originalFilename.lastIndexOf('\\');
            }
            String safeFilename = lastSep >= 0 ? originalFilename.substring(lastSep + 1) : originalFilename;
            if (safeFilename.isEmpty()) {
                result.put("code", 400);
                result.put("msg", "文件名不能为空");
                return result;
            }

            sftp = sshService.getSftpChannel(sessionId);

            // 构建远程文件完整路径
            String remotePath = path;
            if (!remotePath.endsWith("/")) {
                remotePath += "/";
            }
            remotePath += safeFilename;

            // 检查远程文件是否已存在，overwrite=true 时直接覆盖，否则返回 409 让前端确认
            if (!overwrite) {
                boolean exists = false;
                try {
                    sftp.stat(remotePath);
                    exists = true;
                } catch (SftpException ignored) {
                }

                if (exists) {
                    result.put("code", 409);
                    result.put("msg", "文件已存在: " + safeFilename);
                    return result;
                }
            }

            // 通过 SFTP 上传文件
            try (InputStream inputStream = file.getInputStream()) {
                sftp.put(inputStream, remotePath);
            }

            result.put("code", 200);
            result.put("msg", "上传成功");
            result.put("path", remotePath);
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
            } else {
                log.error("WebSSH: 上传文件失败", e);
            }
            result.put("code", 500);
            result.put("msg", "上传失败: " + e.getMessage());
        } finally {
            if (sftp != null) {
                try {
                    sftp.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
        return result;
    }

    /**
     * 解析 cd 命令后的真实工作目录，用于终端与文件浏览器路径同步
     * 参数: target=cd的参数, base=当前终端路径, sessionId=文件会话
     */
    @PostMapping("/resolve-cwd")
    public Map<String, Object> resolveCwd(@RequestBody Map<String, String> params, HttpSession httpSession) {
        Map<String, Object> result = new HashMap<>();
        String sessionId = params.get("sessionId");
        if (sessionId == null || sessionId.isEmpty()) {
            result.put("code", 401);
            result.put("msg", "请先建立SSH连接");
            return result;
        }
        String base = params.get("base");
        String target = params.get("target");
        // 仅允许路径安全字符，防止命令注入；含变量/命令替换/空格等则跳过同步
        if (target != null && !target.isEmpty()
                && !target.matches("^[A-Za-z0-9_./~\\-]+$")) {
            result.put("code", 400);
            result.put("msg", "路径含不支持的字符，跳过同步");
            return result;
        }
        try {
            String path = sshService.resolveCwd(sessionId, base, target);
            if (path == null || !path.startsWith("/")) {
                result.put("code", 500);
                result.put("msg", "无法解析路径");
                return result;
            }
            result.put("code", 200);
            result.put("path", path);
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
            } else {
                log.error("WebSSH: 解析工作目录失败", e);
            }
            result.put("code", 500);
            result.put("msg", e.getMessage());
        }
        return result;
    }

    /**
     * 列出目录内容
     * 参数: path=目录路径（默认根目录 /）
     */
    @GetMapping("/files")
    public Map<String, Object> listFiles(@RequestParam(defaultValue = "/") String path,
                                         @RequestParam(required = false) String sessionId,
                                         HttpSession httpSession) {
        Map<String, Object> result = new HashMap<>();
        ChannelSftp sftp = null;
        try {
            if (sessionId == null || sessionId.isEmpty()) {
                result.put("code", 401);
                result.put("msg", "请先建立SSH连接");
                return result;
            }

            sftp = sshService.getSftpChannel(sessionId);
            // 规范化路径
            if (!path.startsWith("/")) {
                path = "/" + path;
            }

            @SuppressWarnings("unchecked")
            java.util.Vector<ChannelSftp.LsEntry> entries = sftp.ls(path);
            List<Map<String, Object>> fileList = new ArrayList<>();

            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd HH:mm");

            for (ChannelSftp.LsEntry entry : entries) {
                String filename = entry.getFilename();
                // 跳过 . 和 ..
                if (filename.equals(".") || filename.equals("..")) {
                    continue;
                }

                Map<String, Object> fileInfo = new HashMap<>();
                boolean isDir = entry.getAttrs().isDir();
                fileInfo.put("name", filename);
                fileInfo.put("path", path.equals("/") ? "/" + filename : path + "/" + filename);
                fileInfo.put("isDir", isDir);
                fileInfo.put("size", entry.getAttrs().getSize());
                fileInfo.put("permissions", entry.getAttrs().getPermissionsString());
                fileInfo.put("modifyTime", sdf.format(new Date(entry.getAttrs().getMTime() * 1000L)));

                // 文件扩展名（用于图标显示）
                if (!isDir) {
                    int dotIdx = filename.lastIndexOf(".");
                    if (dotIdx > 0) {
                        fileInfo.put("ext", filename.substring(dotIdx + 1).toLowerCase());
                    }
                }
                fileList.add(fileInfo);
            }

            // 排序：目录在前，然后按名称排序
            fileList.sort((a, b) -> {
                boolean aDir = (boolean) a.get("isDir");
                boolean bDir = (boolean) b.get("isDir");
                if (aDir != bDir) {
                    return aDir ? -1 : 1;
                }
                return ((String) a.get("name")).compareToIgnoreCase((String) b.get("name"));
            });

            result.put("code", 200);
            result.put("path", path);
            result.put("parent", getParentPath(path));
            result.put("files", fileList);
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
            } else {
                log.error("WebSSH: 列出目录失败", e);
            }
            result.put("code", 500);
            result.put("msg", "无法访问目录: " + e.getMessage());
        } finally {
            if (sftp != null) {
                try {
                    sftp.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
        return result;
    }

    /**
     * 路径自动补全建议
     * 输入部分路径，返回匹配的目录列表
     */
    @GetMapping("/suggest")
    public Map<String, Object> suggestPaths(@RequestParam String input,
                                            @RequestParam(required = false) String sessionId,
                                            HttpSession httpSession) {
        Map<String, Object> result = new HashMap<>();
        ChannelSftp sftp = null;
        try {
            if (sessionId == null || sessionId.isEmpty()) {
                result.put("code", 401);
                result.put("msg", "请先建立SSH连接");
                return result;
            }

            if (input == null || input.isEmpty()) {
                input = "/";
            }
            if (!input.startsWith("/")) {
                input = "/" + input;
            }

            // 解析父目录和前缀
            // 例: /var/lo -> parent=/var, prefix=lo
            //     /var/  -> parent=/var, prefix=""
            //     /va   -> parent=/,   prefix=va
            int lastSlash = input.lastIndexOf('/');
            String parent = lastSlash == 0 ? "/" : input.substring(0, lastSlash);
            String prefix = input.substring(lastSlash + 1);

            sftp = sshService.getSftpChannel(sessionId);

            @SuppressWarnings("unchecked")
            java.util.Vector<ChannelSftp.LsEntry> entries = sftp.ls(parent);
            List<Map<String, String>> suggestions = new ArrayList<>();

            for (ChannelSftp.LsEntry entry : entries) {
                String filename = entry.getFilename();
                // 跳过 . 和 ..
                if (filename.equals(".") || filename.equals("..")) {
                    continue;
                }
                // 只建议目录
                if (!entry.getAttrs().isDir()) {
                    continue;
                }
                // 按前缀过滤
                if (!filename.startsWith(prefix)) {
                    continue;
                }
                Map<String, String> item = new HashMap<>();
                item.put("name", filename);
                String fullPath = parent.equals("/") ? "/" + filename : parent + "/" + filename;
                item.put("path", fullPath);
                suggestions.add(item);
            }

            // 按名称排序
            suggestions.sort((a, b) -> a.get("name").compareToIgnoreCase(b.get("name")));

            result.put("code", 200);
            result.put("suggestions", suggestions);
        } catch (Exception e) {
            // 父目录不存在或不可访问时返回空列表，不报错
            result.put("code", 200);
            result.put("suggestions", new ArrayList<>());
        } finally {
            if (sftp != null) {
                try {
                    sftp.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
        return result;
    }

    /**
     * 获取当前工作目录
     */
    @GetMapping("/pwd")
    public Map<String, Object> getCurrentPath(@RequestParam(required = false) String sessionId,
                                              HttpSession httpSession) {
        Map<String, Object> result = new HashMap<>();
        ChannelSftp sftp = null;
        try {
            if (sessionId == null || sessionId.isEmpty()) {
                result.put("code", 401);
                result.put("msg", "请先建立SSH连接");
                return result;
            }

            sftp = sshService.getSftpChannel(sessionId);
            String pwd = sftp.pwd();
            result.put("code", 200);
            result.put("path", pwd);
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
            } else {
                log.error("WebSSH: 获取当前路径失败", e);
            }
            result.put("code", 500);
            result.put("msg", e.getMessage());
        } finally {
            if (sftp != null) {
                try {
                    sftp.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
        return result;
    }

    /**
     * 下载文件或目录
     * 目录通过 tar 压缩后下载
     */
    @GetMapping("/download")
    public void downloadFile(@RequestParam String path,
                             @RequestParam(required = false, defaultValue = "false") boolean isDir,
                             @RequestParam(required = false) String sessionId,
                             HttpSession httpSession,
                             HttpServletResponse response) {
        if (isDir) {
            downloadDirectory(path, sessionId, httpSession, response);
        } else {
            downloadSingleFile(path, sessionId, httpSession, response);
        }
    }

    /**
     * 获取文件/目录详细属性
     * 通过 SSH exec 执行 stat 命令
     */
    @GetMapping("/stat")
    public Map<String, Object> getFileStat(@RequestParam String path,
                                           @RequestParam(required = false) String sessionId,
                                           HttpSession httpSession) {
        Map<String, Object> result = new HashMap<>();
        ChannelExec exec = null;
        try {
            sessionId = resolveSessionId(sessionId, httpSession);
            if (sessionId == null) {
                result.put("code", 401);
                result.put("msg", "请先建立SSH连接");
                return result;
            }

            Session jschSession = sshService.getJschSession(sessionId);
            if (jschSession == null) {
                result.put("code", 401);
                result.put("msg", "SSH会话不存在");
                return result;
            }

            exec = (ChannelExec) jschSession.openChannel("exec");
            String safePath = path.replace("'", "'\\''");
            // stat --printf 输出 key=value 格式，便于解析
            exec.setCommand("stat --printf 'type=%F\\nperm=%a\\npermHuman=%A\\nsize=%s\\n" +
                    "uid=%u\\ngid=%g\\nuname=%U\\ngname=%G\\ninode=%i\\nlinks=%h\\n" +
                    "blocks=%b\\nblksize=%o\\natime=%X\\nmtime=%Y\\nctime=%Z\\n' '" + safePath + "' 2>/dev/null");
            exec.setInputStream(null);
            exec.setErrStream(System.err);

            InputStream in = exec.getInputStream();
            exec.connect();

            Scanner scanner = new Scanner(in, "UTF-8").useDelimiter("\\A");
            String output = scanner.hasNext() ? scanner.next().trim() : "";
            scanner.close();

            if (output.isEmpty()) {
                result.put("code", 404);
                result.put("msg", "文件或目录不存在");
                return result;
            }

            // 解析 key=value 输出
            Map<String, String> stat = new HashMap<>();
            for (String line : output.split("\n")) {
                int eqIdx = line.indexOf('=');
                if (eqIdx > 0) {
                    stat.put(line.substring(0, eqIdx), line.substring(eqIdx + 1));
                }
            }

            String fileType = stat.getOrDefault("type", "unknown");
            long totalSize = parseLongSafe(stat.get("size"));
            String totalSizeFormatted = formatFileSize(totalSize);

            // 目录类型：通过 du -sb 递归统计实际大小（字节），再由 formatFileSize 格式化
            if ("directory".equals(fileType)) {
                exec.disconnect();
                exec = (ChannelExec) jschSession.openChannel("exec");
                exec.setCommand("du -sb '" + safePath + "' 2>/dev/null");
                exec.setInputStream(null);
                exec.setErrStream(System.err);
                InputStream duIn = exec.getInputStream();
                exec.connect();

                Scanner duScanner = new Scanner(duIn, "UTF-8");
                if (duScanner.hasNext()) {
                    // du -sb 输出格式: "1234567\t/path"
                    // Scanner 默认按空白分隔，next() 返回的就是字节数
                    totalSize = parseLongSafe(duScanner.next().trim());
                    totalSizeFormatted = formatFileSize(totalSize);
                }
                duScanner.close();
            }

            SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");

            Map<String, Object> props = new HashMap<>();
            props.put("name", extractFilename(path));
            props.put("path", path);
            props.put("type", fileType);
            props.put("permissions", stat.getOrDefault("permHuman", "-"));
            props.put("permissionsOctal", stat.getOrDefault("perm", "000"));
            props.put("size", totalSize);
            props.put("sizeFormatted", totalSizeFormatted);
            props.put("owner", stat.getOrDefault("uname", "unknown"));
            props.put("group", stat.getOrDefault("gname", "unknown"));
            props.put("inode", parseLongSafe(stat.get("inode")));
            props.put("links", parseIntSafe(stat.get("links")));
            props.put("blocks", parseLongSafe(stat.get("blocks")));
            props.put("blockSize", parseIntSafe(stat.get("blksize")));

            long mtimeSec = parseLongSafe(stat.get("mtime"));
            long atimeSec = parseLongSafe(stat.get("atime"));
            long ctimeSec = parseLongSafe(stat.get("ctime"));
            props.put("modifyTime", mtimeSec > 0 ? sdf.format(new Date(mtimeSec * 1000L)) : "-");
            props.put("accessTime", atimeSec > 0 ? sdf.format(new Date(atimeSec * 1000L)) : "-");
            props.put("changeTime", ctimeSec > 0 ? sdf.format(new Date(ctimeSec * 1000L)) : "-");

            result.put("code", 200);
            result.put("data", props);
            return result;
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
            } else {
                log.error("WebSSH: 获取文件属性失败", e);
            }
            result.put("code", 500);
            result.put("msg", e.getMessage());
            return result;
        } finally {
            if (exec != null) {
                try {
                    exec.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private long parseLongSafe(String s) {
        if (s == null || s.isEmpty()) {
            return 0;
        }
        try {
            return Long.parseLong(s);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private int parseIntSafe(String s) {
        if (s == null || s.isEmpty()) {
            return 0;
        }
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    /**
     * 获取目录大小（递归统计，单位字节）
     * 通过 SSH exec 执行 du -sb 命令
     */
    @GetMapping("/calcSize")
    public Map<String, Object> calcDirSize(@RequestParam String path,
                                           @RequestParam(required = false) String sessionId,
                                           HttpSession httpSession) {
        Map<String, Object> result = new HashMap<>();
        ChannelExec exec = null;
        try {
            sessionId = resolveSessionId(sessionId, httpSession);
            if (sessionId == null) {
                result.put("code", 401);
                result.put("msg", "请先建立SSH连接");
                return result;
            }

            Session jschSession = sshService.getJschSession(sessionId);
            if (jschSession == null) {
                result.put("code", 401);
                result.put("msg", "SSH会话不存在");
                return result;
            }

            exec = (ChannelExec) jschSession.openChannel("exec");
            String safePath = path.replace("'", "'\\''");
            // du -sb: 只输出一行，总字节数 + 路径
            exec.setCommand("du -sb '" + safePath + "' 2>/dev/null");
            exec.setInputStream(null);
            exec.setErrStream(System.err);

            InputStream in = exec.getInputStream();
            exec.connect();

            // 读取 du 输出
            Scanner scanner = new Scanner(in, "UTF-8").useDelimiter("\\A");
            String output = scanner.hasNext() ? scanner.next().trim() : "";
            scanner.close();

            long size = 0;
            if (!output.isEmpty()) {
                // du -sb 输出格式: "1234567\t/path"
                String[] parts = output.split("\\s+");
                if (parts.length > 0) {
                    try {
                        size = Long.parseLong(parts[0]);
                    } catch (NumberFormatException ignored) {
                    }
                }
            }

            result.put("code", 200);
            result.put("size", size);
            result.put("sizeFormatted", formatFileSize(size));
            return result;
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
            } else {
                log.error("WebSSH: 计算目录大小失败", e);
            }
            result.put("code", 500);
            result.put("msg", e.getMessage());
            return result;
        } finally {
            if (exec != null) {
                try {
                    exec.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    /**
     * 下载单个文件
     */
    private void downloadSingleFile(String path, String sessionId,
                                    HttpSession httpSession, HttpServletResponse response) {
        ChannelSftp sftp = null;
        try {
            sessionId = resolveSessionId(sessionId, httpSession);
            if (sessionId == null) {
                writeJson(response, 401, "请先建立SSH连接");
                return;
            }

            sftp = sshService.getSftpChannel(sessionId);

            String filename = extractFilename(path);

            try {
                sftp.stat(path);
            } catch (SftpException e) {
                writeJson(response, 404, "文件不存在: " + path);
                return;
            }

            response.setContentType("application/octet-stream");
            response.setHeader("Content-Disposition",
                    "attachment;filename=\"" + URLEncoder.encode(filename, StandardCharsets.UTF_8) + "\"");

            try (InputStream in = sftp.get(path);
                 OutputStream out = response.getOutputStream()) {
                byte[] buffer = new byte[4096];
                int len;
                while ((len = in.read(buffer)) != -1) {
                    out.write(buffer, 0, len);
                }
                out.flush();
            }
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
            } else {
                log.error("WebSSH: 下载文件失败", e);
            }
            if (!response.isCommitted()) {
                try {
                    writeJson(response, 500, e.getMessage());
                } catch (Exception ignored) {
                }
            }
        } finally {
            disconnectSftp(sftp);
        }
    }

    /**
     * 下载目录（通过 tar 压缩）
     */
    private void downloadDirectory(String path, String sessionId,
                                   HttpSession httpSession, HttpServletResponse response) {
        ChannelExec exec = null;
        try {
            sessionId = resolveSessionId(sessionId, httpSession);
            if (sessionId == null) {
                writeJson(response, 401, "请先建立SSH连接");
                return;
            }

            // 验证目录存在
            ChannelSftp sftp = sshService.getSftpChannel(sessionId);
            try {
                sftp.stat(path);
            } catch (SftpException e) {
                disconnectSftp(sftp);
                writeJson(response, 404, "目录不存在: " + path);
                return;
            }
            disconnectSftp(sftp);
            sftp = null;

            // 获取 JSch Session 执行 tar 命令
            Session jschSession = sshService.getJschSession(sessionId);
            if (jschSession == null) {
                writeJson(response, 401, "SSH会话不存在");
                return;
            }

            exec = (ChannelExec) jschSession.openChannel("exec");
            // 使用 tar 压缩目录，-C 切换到目标目录，. 打包当前目录内容
            String dirName = extractFilename(path);
            String safePath = path.replace("'", "'\\''");
            exec.setCommand("cd '" + safePath + "' && tar czf - .");
            exec.setInputStream(null);
            exec.setErrStream(System.err);

            String downloadName = dirName + ".tar.gz";
            response.setContentType("application/octet-stream");
            response.setHeader("Content-Disposition",
                    "attachment;filename=\"" + URLEncoder.encode(downloadName, StandardCharsets.UTF_8) + "\"");

            InputStream in = exec.getInputStream();
            exec.connect();

            OutputStream out = response.getOutputStream();
            byte[] buffer = new byte[4096];
            int len;
            while ((len = in.read(buffer)) != -1) {
                out.write(buffer, 0, len);
            }
            out.flush();
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
            } else {
                log.error("WebSSH: 下载目录失败", e);
            }
            if (!response.isCommitted()) {
                try {
                    writeJson(response, 500, e.getMessage());
                } catch (Exception ignored) {
                }
            }
        } finally {
            if (exec != null) {
                try {
                    exec.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    /**
     * 解析 sessionId（直接返回前端传参，多标签场景下不再回退到 HttpSession 单值）
     */
    private String resolveSessionId(String sessionId, HttpSession httpSession) {
        return sessionId;
    }

    /**
     * 从路径中提取文件名
     */
    private String extractFilename(String path) {
        int lastSlash = path.lastIndexOf('/');
        return lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
    }

    /**
     * 安全断开 SFTP Channel
     */
    private void disconnectSftp(ChannelSftp sftp) {
        if (sftp != null) {
            try {
                sftp.disconnect();
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * 写入 JSON 错误响应
     */
    private void writeJson(HttpServletResponse response, int code, String msg) throws IOException {
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        response.getWriter().write("{\"code\":" + code + ",\"msg\":\"" + msg.replace("\"", "\\\"") + "\"}");
    }

    /**
     * 预览文本文件内容
     * 限制文件大小（默认2MB）
     */
    @GetMapping("/preview")
    public Map<String, Object> previewFile(@RequestParam String path,
                                           @RequestParam(required = false) String sessionId,
                                           HttpSession httpSession) {
        Map<String, Object> result = new HashMap<>();
        ChannelSftp sftp = null;
        try {
            if (sessionId == null || sessionId.isEmpty()) {
                result.put("code", 401);
                result.put("msg", "请先建立SSH连接");
                return result;
            }

            sftp = sshService.getSftpChannel(sessionId);

            // 获取文件大小
            ChannelSftp.LsEntry entry = null;
            try {
                String dir = path.substring(0, path.lastIndexOf('/'));
                String name = path.substring(path.lastIndexOf('/') + 1);
                @SuppressWarnings("unchecked")
                java.util.Vector<ChannelSftp.LsEntry> entries = sftp.ls(path);
                if (entries != null && !entries.isEmpty()) {
                    entry = entries.get(0);
                }
            } catch (Exception ignored) {
            }

            long fileSize = entry != null ? entry.getAttrs().getSize() : 0;
            long maxSize = 2 * 1024 * 1024; // 2MB

            if (fileSize > maxSize) {
                result.put("code", 500);
                result.put("msg", "文件过大（" + formatFileSize(fileSize) + "），不支持预览，请直接下载");
                return result;
            }

            // 读取文件内容
            try (InputStream in = sftp.get(path)) {
                byte[] buffer = new byte[(int) Math.min(fileSize, maxSize)];
                int total = 0;
                int len;
                while (total < buffer.length && (len = in.read(buffer, total, buffer.length - total)) != -1) {
                    total += len;
                }
                String content = new String(buffer, 0, total, StandardCharsets.UTF_8);
                result.put("code", 200);
                result.put("path", path);
                result.put("size", fileSize);
                result.put("content", content);
            }
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
            } else {
                log.error("WebSSH: 预览文件失败", e);
            }
            result.put("code", 500);
            result.put("msg", e.getMessage());
        } finally {
            if (sftp != null) {
                try {
                    sftp.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
        return result;
    }

    /**
     * 执行命令（非交互式）
     */
    @PostMapping("/exec")
    public Map<String, Object> executeCommand(@RequestBody Map<String, String> params,
                                              HttpSession httpSession) {
        Map<String, Object> result = new HashMap<>();
        String sessionId = params.get("sessionId");
        String command = params.get("command");

        if (sessionId == null || sessionId.isEmpty()) {
            result.put("code", 401);
            result.put("msg", "请先建立SSH连接");
            return result;
        }
        if (command == null || command.isEmpty()) {
            result.put("code", 400);
            result.put("msg", "命令不能为空");
            return result;
        }

        try {
            String output = sshService.executeCommand(sessionId, command);
            result.put("code", 200);
            result.put("output", output);
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
            } else {
                log.error("WebSSH: 执行命令失败", e);
            }
            result.put("code", 500);
            result.put("msg", e.getMessage());
        }
        return result;
    }

    /**
     * 获取服务器系统监控信息（CPU、内存、磁盘、负载、网络速率）
     * 通过 SSH exec 执行组合命令采集 /proc 与 df 数据；
     * 网络速率基于会话级临时状态文件做差值计算（首次为 0）。
     */
    @GetMapping("/monitor")
    public Map<String, Object> getMonitorInfo(@RequestParam(required = false) String sessionId,
                                               HttpSession httpSession) {
        Map<String, Object> result = new HashMap<>();
        try {
            sessionId = resolveSessionId(sessionId, httpSession);
            if (sessionId == null || sessionId.isEmpty()) {
                result.put("code", 401);
                result.put("msg", "请先建立SSH连接");
                return result;
            }
            String cmd = buildMonitorCommand(sessionId);
            String output = sshService.executeCommand(sessionId, cmd);
            Map<String, Object> stats = parseMonitorOutput(output);
            result.put("code", 200);
            result.put("data", stats);
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
                result.put("code", 401);
                result.put("msg", "SSH会话已失效");
            } else {
                log.error("WebSSH: 获取监控信息失败", e);
                result.put("code", 500);
                result.put("msg", e.getMessage());
            }
        }
        return result;
    }

    /**
     * 构造采集系统监控信息的组合 shell 命令
     * 输出 key=value 格式（cpu/mem/disk/load/rx/tx），其中 rx/tx 为字节/秒
     *
     * 采集方式：
     * - CPU：读取 /proc/stat 两次（间隔 0.3s）计算使用率
     * - 内存：/proc/meminfo 的 MemTotal 与 MemAvailable
     * - 磁盘：df 根分区使用率
     * - 负载：/proc/loadavg 的 1 分钟平均
     * - 网络：/proc/net/dev 累计收发字节，与上次采样（状态文件）做差除以时间间隔
     */
    private String buildMonitorCommand(String sessionId) {
        // 用 sessionId 派生安全的状态文件名，保存上次网络字节计数用于速率差值计算
        String safeKey = sessionId.replaceAll("[^A-Za-z0-9]", "");
        return "F=/tmp/.webssh_mon_" + safeKey + ";" +
                "PREV_RX=0;PREV_TX=0;PREV_TS=0;" +
                "[ -f \"$F\" ] && . \"$F\";" +
                "C1=$(awk '/^cpu /{s=0;for(i=2;i<=8;i++)s+=$i;print s;exit}' /proc/stat);" +
                "I1=$(awk '/^cpu /{print $5;exit}' /proc/stat);" +
                "sleep 0.3;" +
                "C2=$(awk '/^cpu /{s=0;for(i=2;i<=8;i++)s+=$i;print s;exit}' /proc/stat);" +
                "I2=$(awk '/^cpu /{print $5;exit}' /proc/stat);" +
                "CPU=$(awk -v c1=$C1 -v i1=$I1 -v c2=$C2 -v i2=$I2 'BEGIN{dt=c2-c1;di=i2-i1;if(dt>0)printf \"%.1f\",(dt-di)/dt*100;else print 0}');" +
                "MEM=$(awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{if(t>0)printf \"%.1f\",(t-a)/t*100;else print 0}' /proc/meminfo);" +
                "DISK=$(df -P / 2>/dev/null | awk 'NR==2{gsub(/%/,\"\");print $5}');" +
                "LOAD=$(awk '{print $1}' /proc/loadavg);" +
                "NET=$(awk '/:/ && $1!=\"lo:\" {r+=$2;t+=$10}END{print r+0,t+0}' /proc/net/dev);" +
                "RX=$(echo $NET | awk '{print $1}');TX=$(echo $NET | awk '{print $2}');" +
                "TS=$(date +%s);" +
                "RXRATE=0;TXRATE=0;" +
                "if [ -n \"$PREV_RX\" ] && [ \"$PREV_TS\" -gt 0 ] 2>/dev/null;then IV=$((TS-PREV_TS));if [ $IV -gt 0 ];then RXRATE=$(( (RX-PREV_RX)/IV ));TXRATE=$(( (TX-PREV_TX)/IV ));fi;[ $RXRATE -lt 0 ] && RXRATE=0;[ $TXRATE -lt 0 ] && TXRATE=0;fi;" +
                "printf 'PREV_RX=%s\\nPREV_TX=%s\\nPREV_TS=%s\\n' $RX $TX $TS > \"$F\";" +
                "printf 'cpu=%s\\nmem=%s\\ndisk=%s\\nload=%s\\nrx=%s\\ntx=%s\\n' \"$CPU\" \"$MEM\" \"$DISK\" \"$LOAD\" \"$RXRATE\" \"$TXRATE\"";
    }

    /**
     * 解析监控命令输出的 key=value 行为 Map
     */
    private Map<String, Object> parseMonitorOutput(String output) {
        Map<String, Object> stats = new LinkedHashMap<>();
        if (output == null) {
            return stats;
        }
        for (String line : output.split("\n")) {
            int eq = line.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String key = line.substring(0, eq).trim();
            String val = line.substring(eq + 1).trim();
            // 跳过 executeCommand 在非零退出码时追加的 [exit code: N] 行
            if (key.startsWith("[")) {
                continue;
            }
            stats.put(key, val);
        }
        return stats;
    }

    /**
     * 获取服务器监控详情（CPU/RAM/Disk/Load/Net）
     * 按 type 执行不同采集命令，返回更丰富的结构化数据
     */
    @GetMapping("/monitor/detail")
    public Map<String, Object> getMonitorDetail(@RequestParam String type,
                                                 @RequestParam(required = false) String sessionId,
                                                 HttpSession httpSession) {
        Map<String, Object> result = new HashMap<>();
        try {
            sessionId = resolveSessionId(sessionId, httpSession);
            if (sessionId == null || sessionId.isEmpty()) {
                result.put("code", 401);
                result.put("msg", "请先建立SSH连接");
                return result;
            }
            String cmd = buildDetailCommand(type, sessionId);
            if (cmd == null) {
                result.put("code", 400);
                result.put("msg", "不支持的监控类型: " + type);
                return result;
            }
            String output = sshService.executeCommand(sessionId, cmd);
            Map<String, Object> data = parseDetailOutput(output);
            result.put("code", 200);
            result.put("type", type);
            result.put("data", data);
        } catch (Exception e) {
            if (isSessionExpiredError(e)) {
                log.warn("WebSSH: 文件会话已失效: {}", e.getMessage());
                result.put("code", 401);
                result.put("msg", "SSH会话已失效");
            } else {
                log.error("WebSSH: 获取监控详情失败 type={}", type, e);
                result.put("code", 500);
                result.put("msg", e.getMessage());
            }
        }
        return result;
    }

    /**
     * 按监控类型构造详情采集命令
     * 输出约定：
     * - 普通字段：key=value 每行一个
     * - 列表项：part|fs|size|used|avail|use|mount（磁盘分区）
     *           iface|name|rx|tx|rxRate|txRate（网络接口）
     */
    private String buildDetailCommand(String type, String sessionId) {
        String safeKey = sessionId.replaceAll("[^A-Za-z0-9]", "");
        switch (type) {
            case "cpu":
                return "MODEL=$(awk -F: '/model name/{gsub(/^ +/,\"\",$2);print $2;exit}' /proc/cpuinfo);" +
                        "CORES=$(grep -c '^processor' /proc/cpuinfo);" +
                        "FREQ=$(awk -F: '/cpu MHz/{gsub(/^ +/,\"\",$2);print $2;exit}' /proc/cpuinfo);" +
                        "UP=$(awk '{print int($1)}' /proc/uptime);" +
                        "UPF=$(awk '{d=int($1/86400);h=int(($1%86400)/3600);m=int(($1%3600)/60);printf \"%d天 %d时 %d分\",d,h,m}' /proc/uptime);" +
                        "T1=$(awk '/^cpu /{s=0;for(i=2;i<=8;i++)s+=$i;print s;exit}' /proc/stat);I1=$(awk '/^cpu /{print $5;exit}' /proc/stat);" +
                        "C1=$(awk '/^cpu[0-9]/{s=0;for(i=2;i<=8;i++)s+=$i;print $1,s,$5}' /proc/stat);" +
                        "sleep 0.3;" +
                        "T2=$(awk '/^cpu /{s=0;for(i=2;i<=8;i++)s+=$i;print s;exit}' /proc/stat);I2=$(awk '/^cpu /{print $5;exit}' /proc/stat);" +
                        "C2=$(awk '/^cpu[0-9]/{s=0;for(i=2;i<=8;i++)s+=$i;print $1,s,$5}' /proc/stat);" +
                        "TOTAL=$(awk -v t1=$T1 -v i1=$I1 -v t2=$T2 -v i2=$I2 'BEGIN{d=t2-t1;di=i2-i1;if(d>0)printf \"%.1f\",(d-di)/d*100;else print 0}');" +
                        "printf 'model=%s\\ncores=%s\\nfreq=%s\\nuptime=%s\\nuptime_fmt=%s\\nusage=%s\\n' \"$MODEL\" \"$CORES\" \"$FREQ\" \"$UP\" \"$UPF\" \"$TOTAL\";" +
                        "awk -v a=\"$C1\" -v b=\"$C2\" 'BEGIN{na=split(a,la,\"\\n\");split(b,lb,\"\\n\");for(i=1;i<=na;i++){if(la[i]==\"\")continue;split(la[i],x,\" \");split(lb[i],y,\" \");dt=y[2]-x[2];di=y[3]-x[3];if(dt>0)printf \"%s=%.1f\\n\",x[1],(dt-di)/dt*100;else printf \"%s=0\\n\",x[1]}}'";
            case "mem":
                return "awk '/^MemTotal:/{t=$2}/^MemFree:/{f=$2}/^MemAvailable:/{a=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}/^SwapTotal:/{st=$2}/^SwapFree:/{sf=$2}END{printf \"mem_total=%d\\nmem_free=%d\\nmem_available=%d\\nmem_buffers=%d\\nmem_cached=%d\\nswap_total=%d\\nswap_free=%d\\n\",t,f,a,b,c,st,sf}' /proc/meminfo";
            case "disk":
                return "df -P 2>/dev/null | awk 'NR>1{gsub(/%/,\"\",$5);printf \"part|%s|%s|%s|%s|%s|%s\\n\",$1,$2,$3,$4,$5,$6}'";
            case "load":
                return "L=$(cat /proc/loadavg);" +
                        "L1=$(echo $L | awk '{print $1}');L5=$(echo $L | awk '{print $2}');L15=$(echo $L | awk '{print $3}');PROC=$(echo $L | awk '{print $4}');" +
                        "CORES=$(grep -c '^processor' /proc/cpuinfo);" +
                        "UP=$(awk '{print int($1)}' /proc/uptime);" +
                        "UPF=$(awk '{d=int($1/86400);h=int(($1%86400)/3600);m=int(($1%3600)/60);printf \"%d天 %d时 %d分\",d,h,m}' /proc/uptime);" +
                        "printf 'load1=%s\\nload5=%s\\nload15=%s\\nproc=%s\\ncores=%s\\nuptime=%s\\nuptime_fmt=%s\\n' \"$L1\" \"$L5\" \"$L15\" \"$PROC\" \"$CORES\" \"$UP\" \"$UPF\"";
            case "net":
                return "F=/tmp/.webssh_mon_dnet_" + safeKey + ";" +
                        "TS=$(date +%s);" +
                        "NOW=$(awk '/:/ && $1!=\"lo:\" {gsub(/:/,\"\",$1);print $1,$2,$10}' /proc/net/dev);" +
                        "PREV=\"\";[ -f \"$F\" ] && PREV=$(cat \"$F\");" +
                        "{ echo \"ts $TS\"; printf '%s\\n' \"$NOW\"; } > \"$F\";" +
                        "awk -v now=\"$NOW\" -v prev=\"$PREV\" -v ts=\"$TS\" 'BEGIN{" +
                        "if(prev!=\"\"){n=split(prev,lp,\"\\n\");for(i=1;i<=n;i++){split(lp[i],p,\" \");if(p[1]==\"ts\")pts=p[2];else{pm[p[1]]=p[2];pm[p[1]\"t\"]=p[3]}}}" +
                        "if(pts==\"\")pts=ts;nn=split(now,ln,\"\\n\");trxr=0;ttxr=0;" +
                        "for(i=1;i<=nn;i++){split(ln[i],x,\" \");if(x[1]==\"\")continue;rx=x[2]+0;tx=x[3]+0;rrate=0;trate=0;" +
                        "if(pm[x[1]]!=\"\"&&ts>pts){iv=ts-pts;if(iv>0){rrate=int((rx-pm[x[1]])/iv);trate=int((tx-pm[x[1]\"t\"])/iv)}}" +
                        "if(rrate<0)rrate=0;if(trate<0)trate=0;trxr+=rrate;ttxr+=trate;printf \"iface|%s|%d|%d|%d|%d\\n\",x[1],rx,tx,rrate,trate}" +
                        "printf \"total_rx_rate=%d\\ntotal_tx_rate=%d\\n\",trxr,ttxr}'";
            default:
                return null;
        }
    }

    /**
     * 解析详情命令输出：
     * - part|... 行 → partitions 列表
     * - iface|... 行 → interfaces 列表
     * - 其余 key=value → 普通字段（含 CPU 各核心 cpuN=value）
     */
    private Map<String, Object> parseDetailOutput(String output) {
        Map<String, Object> data = new LinkedHashMap<>();
        List<Map<String, Object>> partitions = new ArrayList<>();
        List<Map<String, Object>> interfaces = new ArrayList<>();
        if (output == null) {
            return data;
        }
        for (String line : output.split("\n")) {
            line = line.trim();
            if (line.isEmpty()) {
                continue;
            }
            if (line.startsWith("part|")) {
                String[] f = line.split("\\|");
                if (f.length >= 7) {
                    Map<String, Object> p = new LinkedHashMap<>();
                    p.put("fs", f[1]);
                    p.put("size", parseLongSafe(f[2]));
                    p.put("used", parseLongSafe(f[3]));
                    p.put("avail", parseLongSafe(f[4]));
                    p.put("use", parseIntSafe(f[5]));
                    p.put("mount", f[6]);
                    partitions.add(p);
                }
            } else if (line.startsWith("iface|")) {
                String[] f = line.split("\\|");
                if (f.length >= 6) {
                    Map<String, Object> p = new LinkedHashMap<>();
                    p.put("name", f[1]);
                    p.put("rx", parseLongSafe(f[2]));
                    p.put("tx", parseLongSafe(f[3]));
                    p.put("rxRate", parseLongSafe(f[4]));
                    p.put("txRate", parseLongSafe(f[5]));
                    interfaces.add(p);
                }
            } else {
                int eq = line.indexOf('=');
                if (eq > 0) {
                    String key = line.substring(0, eq).trim();
                    String val = line.substring(eq + 1).trim();
                    if (!key.startsWith("[")) {
                        data.put(key, val);
                    }
                }
            }
        }
        if (!partitions.isEmpty()) {
            data.put("partitions", partitions);
        }
        if (!interfaces.isEmpty()) {
            data.put("interfaces", interfaces);
        }
        return data;
    }

    /**
     * 计算父路径
     */
    private String getParentPath(String path) {
        if (path == null || path.equals("/") || path.isEmpty()) {
            return "/";
        }
        // 去除末尾的 /
        if (path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }
        int lastSlash = path.lastIndexOf('/');
        if (lastSlash <= 0) {
            return "/";
        }
        return path.substring(0, lastSlash);
    }

    /**
     * 判断异常是否为文件会话不存在（服务端重启或会话超时导致的预期错误）
     * 此类错误由前端自动重连处理，无需以 ERROR 级别打印完整堆栈
     */
    private boolean isSessionExpiredError(Exception e) {
        return e instanceof IllegalStateException
                && e.getMessage() != null
                && e.getMessage().contains("SSH会话不存在");
    }

    /**
     * 格式化文件大小
     */
    private String formatFileSize(long size) {
        if (size < 1024) {
            return size + " B";
        } else if (size < 1024 * 1024) {
            return String.format("%.1f KB", size / 1024.0);
        } else if (size < 1024 * 1024 * 1024) {
            return String.format("%.1f MB", size / (1024.0 * 1024));
        } else {
            return String.format("%.1f GB", size / (1024.0 * 1024 * 1024));
        }
    }
}
