package com.yyj;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.Environment;

import java.net.InetAddress;
import java.net.NetworkInterface;
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
        // 启动后，控制台输出访问地址：http://本机ip:部署端口/{webssh.context-path}/login.html
        logAccessUrl(context);
    }

    /**
     * 启动后在控制台输出 WebSSH 访问地址
     */
    private static void logAccessUrl(ConfigurableApplicationContext context) {
        Environment env = context.getEnvironment();

        // 若 webssh.enabled=false（WebSSH 已关闭），则不输出访问地址
        boolean enabled = env.getProperty("webssh.enabled", Boolean.class, true);
        if (!enabled) {
            log.info("WebSSH 已关闭（webssh.enabled=false）");
            return;
        }

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
        log.info("WebSSH 启动成功，访问地址：{}", url);
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
