package com.yyj;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.Environment;

import java.awt.Desktop;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.util.Enumeration;

/**
 * WebSSH Web 应用启动类
 *
 * @author yyj
 */
@SpringBootApplication
public class WebSshApplication {
    private static final Logger log = LoggerFactory.getLogger(WebSshApplication.class);

    public static void main(String[] args) {
        ConfigurableApplicationContext context = SpringApplication.run(WebSshApplication.class, args);
        // 启动后，自动打开浏览器访问地址：http://本机ip:部署端口/{webssh.context-path}/login.html
        openBrowser(context);
    }

    /**
     * 启动后自动打开浏览器访问 WebSSH 登录页
     */
    private static void openBrowser(ConfigurableApplicationContext context) {
        Environment env = context.getEnvironment();

        // 若 webssh.enabled=false（WebSSH 已关闭），则不自动打开浏览器
        boolean enabled = env.getProperty("webssh.enabled", Boolean.class, true);
        if (!enabled) {
            log.info("WebSSH 已关闭（webssh.enabled=false），跳过自动打开浏览器");
            return;
        }

        // 1. 构造访问地址（与打开浏览器解耦，IP 检测失败不阻断浏览器打开）
        String url;
        try {
            String port = env.getProperty("server.port", "8080");
            String websshContextPath = normalizeContextPath(env.getProperty("webssh.context-path", "/webssh"));
            String ip = getLocalIp();
            url = String.format("http://%s:%s%s/login.html", ip, port, websshContextPath);
        } catch (Exception e) {
            log.warn("构造 WebSSH 访问地址失败，回退到 localhost：{}", e.getMessage());
            url = "http://127.0.0.1:8080/webssh/login.html";
        }
        log.info("WebSSH 访问地址：{}", url);

        // 2. 打开浏览器
        browse(url);
    }

    /**
     * 打开浏览器：优先使用 Desktop API，失败则回退到平台命令
     */
    private static void browse(String url) {
        // 优先尝试 Desktop API
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI.create(url));
                return;
            }
        } catch (Exception e) {
            log.warn("Desktop.browse 打开浏览器失败，尝试回退方案：{}", e.getMessage());
        }
        // 回退方案：按操作系统调用原生命令
        try {
            String os = System.getProperty("os.name", "").toLowerCase();
            ProcessBuilder pb;
            if (os.contains("win")) {
                pb = new ProcessBuilder("rundll32", "url.dll,FileProtocolHandler", url);
            } else if (os.contains("mac")) {
                pb = new ProcessBuilder("open", url);
            } else {
                pb = new ProcessBuilder("xdg-open", url);
            }
            pb.inheritIO().start();
        } catch (Exception e) {
            log.error("打开浏览器失败，请手动访问上述地址", e);
        }
    }

    /**
     * 规范化 context-path，确保以 / 开头且不以 / 结尾
     */
    private static String normalizeContextPath(String contextPath) {
        if (contextPath == null || contextPath.isEmpty()) {
            return "";
        }
        if (!contextPath.startsWith("/")) {
            contextPath = "/" + contextPath;
        }
        if (contextPath.endsWith("/")) {
            contextPath = contextPath.substring(0, contextPath.length() - 1);
        }
        return contextPath;
    }

    /**
     * 获取本机非回环 IPv4 地址，失败时回退到 127.0.0.1
     */
    private static String getLocalIp() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface ni = interfaces.nextElement();
                if (!ni.isUp() || ni.isLoopback()) {
                    continue;
                }
                Enumeration<InetAddress> addresses = ni.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress addr = addresses.nextElement();
                    // 排除回环地址，仅取 IPv4 地址
                    if (!addr.isLoopbackAddress() && addr.getAddress().length == 4) {
                        return addr.getHostAddress();
                    }
                }
            }
            return InetAddress.getLocalHost().getHostAddress();
        } catch (Exception e) {
            log.warn("获取本机 IP 失败，回退到 127.0.0.1：{}", e.getMessage());
            return "127.0.0.1";
        }
    }
}
