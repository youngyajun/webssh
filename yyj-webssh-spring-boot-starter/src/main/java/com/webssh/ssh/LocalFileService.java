package com.webssh.ssh;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.NotDirectoryException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFileAttributes;
import java.nio.file.attribute.PosixFilePermissions;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 本地文件服务
 * 用于 type=local 的主机配置：直接用 java.nio.file 操作本机文件系统，替代 SFTP。
 * 适用场景：webssh 与目标 Linux 服务器同机部署，文件管理器无需建立 SSH 连接。
 *
 * 所有方法均为静态方法，由 {@link SshService} 和 WebSshFileController 调用。
 * 使用 NIO.2 流式 API，避免大目录或大文件一次性加载到内存。
 *
 * @author webssh
 */
public class LocalFileService {
    private static final Logger log = LoggerFactory.getLogger(LocalFileService.class);

    /**
     * 列出目录内容
     * 用 Files.newDirectoryStream() 流式遍历，避免一次性加载大目录
     *
     * @param path 目录绝对路径
     * @return List<Map>，每项包含字段：
     *   - name: 文件名
     *   - path: 完整路径
     *   - isDir: 是否目录
     *   - size: 文件大小（字节）
     *   - permissions: 权限字符串（如 "rwxr-xr-x"）
     *   - modifyTime: 修改时间字符串（格式 "yyyy-MM-dd HH:mm"）
     *   - ext: 文件扩展名（非目录时）
     * @throws IOException 目录不存在或不是目录时抛出对应异常
     */
    public static List<Map<String, Object>> listFiles(String path) throws IOException {
        Path dir = Paths.get(path);
        if (!Files.exists(dir)) {
            throw new NoSuchFileException("目录不存在: " + path);
        }
        if (!Files.isDirectory(dir)) {
            throw new NotDirectoryException("不是目录: " + path);
        }

        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd HH:mm");
        List<Map<String, Object>> fileList = new ArrayList<>();

        // 用 try-with-resources 确保 DirectoryStream 关闭
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
            for (Path entry : stream) {
                String filename = entry.getFileName().toString();
                // DirectoryStream 不会返回 . 和 ..，无需额外跳过

                Map<String, Object> fileInfo = new HashMap<>();
                BasicFileAttributes attrs = Files.readAttributes(entry, BasicFileAttributes.class);
                boolean isDir = attrs.isDirectory();

                fileInfo.put("name", filename);
                fileInfo.put("path", path.equals("/") ? "/" + filename : path + "/" + filename);
                fileInfo.put("isDir", isDir);
                fileInfo.put("size", attrs.size());
                fileInfo.put("permissions", getPermissionsString(entry));
                fileInfo.put("modifyTime", sdf.format(new Date(attrs.lastModifiedTime().toMillis())));

                if (!isDir) {
                    int dotIdx = filename.lastIndexOf(".");
                    if (dotIdx > 0) {
                        fileInfo.put("ext", filename.substring(dotIdx + 1).toLowerCase());
                    }
                }
                fileList.add(fileInfo);
            }
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

        return fileList;
    }

    /**
     * 获取文件权限字符串（POSIX 风格，如 "rwxr-xr-x"）
     * 非 POSIX 文件系统（如 Windows）返回 "---------"
     *
     * @param path 文件路径
     * @return 权限字符串
     */
    private static String getPermissionsString(Path path) {
        try {
            PosixFileAttributes attrs = Files.readAttributes(path, PosixFileAttributes.class);
            return PosixFilePermissions.toString(attrs.permissions());
        } catch (Exception e) {
            // 非 POSIX 文件系统（如 Windows）或不支持 POSIX 属性时返回默认值
            return "---------";
        }
    }

    /**
     * 上传文件（流式写入，避免 OOM）
     * 目标父目录不存在时自动创建
     *
     * @param in 输入流
     * @param remotePath 目标完整路径
     * @param overwrite 是否覆盖
     * @throws IOException 文件已存在且 overwrite=false 时抛 FileAlreadyExistsException
     */
    public static void uploadFile(InputStream in, String remotePath, boolean overwrite) throws IOException {
        Path target = Paths.get(remotePath);
        Path parent = target.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        // 用 StandardCopyOption 控制覆盖行为
        if (overwrite) {
            Files.copy(in, target, StandardCopyOption.REPLACE_EXISTING);
        } else {
            // 不覆盖时检查是否存在
            if (Files.exists(target)) {
                throw new FileAlreadyExistsException("文件已存在: " + target);
            }
            Files.copy(in, target);
        }
    }

    /**
     * 下载文件（流式写出，避免全文件加载到内存）
     * 用 Files.copy(Path, OutputStream) 内部流式传输
     *
     * @param path 文件完整路径
     * @param out 响应输出流
     * @throws IOException 文件不存在或读取失败时抛出
     */
    public static void downloadFile(String path, OutputStream out) throws IOException {
        Path source = Paths.get(path);
        if (!Files.exists(source)) {
            throw new NoSuchFileException("文件不存在: " + path);
        }
        // Files.copy(Path, OutputStream) 内部流式传输，避免全文件加载到内存
        Files.copy(source, out);
        out.flush();
    }

    /**
     * 下载目录为 tar.gz（用 ProcessBuilder 执行 tar，与 SSH 模式行为一致）
     * 命令：tar czf - -C <parent> <dirname>
     *
     * @param path 目录完整路径
     * @param out 响应输出流
     * @throws IOException 不是目录或 tar 打包失败时抛出
     */
    public static void downloadDirectory(String path, OutputStream out) throws IOException {
        Path dir = Paths.get(path);
        if (!Files.isDirectory(dir)) {
            throw new NotDirectoryException("不是目录: " + path);
        }
        Path parent = dir.getParent();
        String dirName = dir.getFileName().toString();

        // 用 ProcessBuilder 执行 tar，与 SSH 模式行为一致
        // 命令：tar czf - -C <parent> <dirname>
        ProcessBuilder pb = new ProcessBuilder("tar", "czf", "-", "-C",
                parent != null ? parent.toString() : "/", dirName);
        pb.redirectErrorStream(false);
        Process process = pb.start();

        // 流式传输 tar 输出到 response
        try (InputStream tarIn = process.getInputStream()) {
            byte[] buffer = new byte[8192];
            int len;
            while ((len = tarIn.read(buffer)) != -1) {
                out.write(buffer, 0, len);
            }
        }
        out.flush();

        try {
            int exitCode = process.waitFor();
            if (exitCode != 0) {
                throw new IOException("tar 打包失败，exit code: " + exitCode);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("tar 打包被中断", e);
        }
    }

    /**
     * 检查文件是否存在
     *
     * @param path 文件完整路径
     * @return 存在返回 true，否则 false
     */
    public static boolean fileExists(String path) {
        return Files.exists(Paths.get(path));
    }

    /**
     * 获取当前工作目录
     * 返回 webssh 进程的当前工作目录（System.getProperty("user.dir")）
     *
     * @return 当前工作目录绝对路径
     */
    public static String getCurrentPath() {
        return System.getProperty("user.dir");
    }

    /**
     * 路径建议（用于前端输入框自动补全）
     *
     * 行为规则：
     * 1. input 为 "/" → 列出根目录下所有子目录（修复 PTY 模式特有 bug：
     *    原实现用 Paths.get("/").getParent() 返回 null，导致返回空列表）
     * 2. input 本身是一个已存在的目录（如 /var）→ 列出其下所有子目录（/var/log、/var/lib 等）
     *    这样用户输入完整目录路径时能直接看到子目录，更符合直觉
     * 3. input 是部分路径（如 /var/l）→ 列出父目录 /var 下以 l 开头的子目录（补全模式）
     *
     * 仅返回目录，跳过 . 和 ..。
     * 支持 ~ 开头的路径（以 user.home 解析）。
     *
     * 返回结构每项包含 name 和 path 两个字段，前端通过 s.name / s.path 访问。
     *
     * @param input 用户输入路径
     * @return List<Map> 匹配的目录列表，每项含 name 与 path 字段
     * @throws IOException 读取目录失败时抛出
     */
    public static List<Map<String, String>> suggestPaths(String input) throws IOException {
        if (input == null || input.isEmpty()) {
            return Collections.emptyList();
        }

        // 处理 ~ 开头路径：以 user.home 解析
        if (input.startsWith("~")) {
            String home = System.getProperty("user.home");
            input = home + input.substring(1);
        }

        // 规范化输入：去除结尾的 /（除了根目录 "/"）
        // 否则 Paths.get("/var/").getFileName() 返回 null，影响后续 prefix 计算
        if (input.length() > 1 && input.endsWith("/")) {
            input = input.substring(0, input.length() - 1);
        }

        Path inputPath = Paths.get(input);

        // 确定要列出的目录（listDir）和前缀（prefix）
        Path listDir;
        String prefix;

        if (input.equals("/")) {
            // 边界 case：根目录，列出 / 下所有子目录
            // Paths.get("/").getParent() 返回 null，若按补全模式处理会返回空，
            // 这与 SSH 模式行为不一致（SSH 模式用 lastIndexOf('/') 解析，parent="/"，能列出根目录所有目录）
            listDir = Paths.get("/");
            prefix = "";
        } else if (Files.isDirectory(inputPath)) {
            // input 本身是一个已存在的目录：列出其下所有子目录
            // 用户输入 /var 时直接看到 /var/log /var/lib 等子目录，更符合直觉
            listDir = inputPath;
            prefix = "";
        } else {
            // input 是部分路径（补全模式）：列出父目录下以 basename 开头的子目录
            // 例：输入 /var/l → 列出 /var 下以 l 开头的子目录
            Path parent = inputPath.getParent();
            if (parent == null) {
                return Collections.emptyList();
            }
            if (!Files.isDirectory(parent)) {
                return Collections.emptyList();
            }
            listDir = parent;
            prefix = inputPath.getFileName() != null ? inputPath.getFileName().toString() : "";
        }

        return listChildDirs(listDir, prefix);
    }

    /**
     * 列出指定目录下所有以 prefix 开头的子目录
     * 跳过 . 和 ..，按名称排序
     *
     * @param parentDir 要列出的目录
     * @param prefix    名称前缀过滤（空字符串表示不过滤）
     * @return List<Map> 每项含 name 与 path 字段
     * @throws IOException 读取目录失败时抛出
     */
    private static List<Map<String, String>> listChildDirs(Path parentDir, String prefix) throws IOException {
        // 父目录字符串（用于构造完整 path）：
        // parent 为 "/" 时不重复斜杠，否则为 parent + "/" + name
        String parentStr = parentDir.toString();

        List<Map<String, String>> suggestions = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(parentDir)) {
            for (Path entry : stream) {
                String name = entry.getFileName().toString();
                // 跳过 . 和 ..
                if (name.equals(".") || name.equals("..")) {
                    continue;
                }
                // 仅建议目录
                if (!Files.isDirectory(entry)) {
                    continue;
                }
                // 按前缀过滤
                if (!name.startsWith(prefix)) {
                    continue;
                }
                Map<String, String> item = new HashMap<>();
                item.put("name", name);
                item.put("path", parentStr.equals("/") ? "/" + name : parentStr + "/" + name);
                suggestions.add(item);
            }
        }

        // 按名称排序
        suggestions.sort((a, b) -> a.get("name").compareToIgnoreCase(b.get("name")));
        return suggestions;
    }

    /**
     * 预览文件内容（限制最大字节数，避免恶意大文件 OOM）
     * 调用方应先检查文件大小，超过 maxSize 时抛出 IOException
     *
     * @param path 文件完整路径
     * @param maxSize 最大读取字节数
     * @return 文件内容字符串（UTF-8）
     * @throws IOException 文件不存在或超过大小限制时抛出
     */
    public static String previewFile(String path, long maxSize) throws IOException {
        Path source = Paths.get(path);
        if (!Files.exists(source)) {
            throw new NoSuchFileException("文件不存在: " + path);
        }
        long fileSize = Files.size(source);
        if (fileSize > maxSize) {
            throw new IOException("文件超过预览大小限制: " + maxSize + " 字节");
        }
        // 文件大小已校验，可安全一次性读取
        byte[] bytes = Files.readAllBytes(source);
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
