package com.webssh.websocket;

import com.webssh.config.WebSshProperties;
import com.webssh.ssh.LocalPtyService;
import com.webssh.util.RsaSessionHelper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

import java.util.Map;

/**
 * WebSocket 配置
 *
 * @author webssh
 */
@Configuration
@EnableWebSocket
public class WebSshWebSocketConfig implements WebSocketConfigurer {
    private static final Logger log = LoggerFactory.getLogger(WebSshWebSocketConfig.class);

    @Autowired
    private WebSshProperties properties;

    @Autowired
    private WebSshWebSocketHandler webSshWebSocketHandler;

    @Autowired
    private LocalPtyService localPtyService;

    /**
     * 配置 WebSocket 容器的缓冲区大小和会话超时
     * 默认 maxBinaryMessageBufferSize=8KB 太小，ZMODEM rz/sz 大文件传输时
     * 单条二进制消息可能远超 8KB，会触发 close code 1009 强制断连。
     * 调大到 10MB 以支持大文件传输；sessionIdleTimeout=0 表示不超时
     * （ZMODEM 大文件传输耗时长，避免被 idle 检查误杀）
     */
    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxBinaryMessageBufferSize(10 * 1024 * 1024);
        container.setMaxTextMessageBufferSize(1 * 1024 * 1024);
        container.setMaxSessionIdleTimeout(0L);
        return container;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        if (!properties.isEnabled()) {
            return;
        }

        String wsPath = properties.getContextPath() + "/ws";
        registry.addHandler(webSshWebSocketHandler, wsPath)
                .addInterceptors(new WebSshHandshakeInterceptor())
                .setAllowedOrigins("*");
    }

    /**
     * 握手拦截器，从 URL 参数中提取 host、username、password 参数
     * password 为 RSA 加密后的 Base64 密文，在此处用 Session 中的私钥解密
     *
     * 注意：本拦截器为非静态内部类，以访问外部类的 localPtyService 字段。
     * Windows + 本地 PTY 模式的拒绝在此完成，避免握手成功后 onopen 触发又被 close
     * 导致前端重连死循环（onopen 重置 reconnectAttempts → onclose → 重连 → 死循环）。
     */
    private class WebSshHandshakeInterceptor implements HandshakeInterceptor {
        @Override
        public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                       WebSocketHandler wsHandler, Map<String, Object> attributes) {
            if (request instanceof ServletServerHttpRequest) {
                HttpServletRequest servletRequest = ((ServletServerHttpRequest) request).getServletRequest();

                // 安全检查：校验 HttpSession 中的登录标记，未登录直接拒绝握手
                HttpSession httpSession = servletRequest.getSession(false);
                Boolean loggedIn = httpSession != null
                        ? (Boolean) httpSession.getAttribute("webssh_logged_in") : null;
                if (loggedIn == null || !loggedIn) {
                    log.warn("WebSSH: WebSocket 握手被拒绝，未登录或会话已过期");
                    return false;
                }

                String host = servletRequest.getParameter("host");
                if (host != null && !host.isEmpty()) {
                    // 本地 PTY 模式在 Windows 上不支持：握手阶段直接拒绝，避免 onopen 触发后
                    // 后端 initConnection 抛异常关闭导致前端重连死循环
                    if (localPtyService.isLocalHost(host) && isWindowsOs()) {
                        log.warn("WebSSH: 拒绝握手 - 本地 PTY 模式不支持 Windows，host={}", host);
                        response.setStatusCode(HttpStatus.FORBIDDEN);
                        return false;
                    }

                    attributes.put("host", host);

                    // 获取可选的用户名参数
                    String username = servletRequest.getParameter("username");
                    if (username != null && !username.isEmpty()) {
                        attributes.put("sshUsername", username);
                    }

                    // 获取初始终端尺寸参数（前端在握手前已 fit 一次），用于 PTY 初始化
                    String cols = servletRequest.getParameter("cols");
                    String rows = servletRequest.getParameter("rows");
                    if (cols != null && !cols.isEmpty()) {
                        attributes.put("initialCols", cols);
                    }
                    if (rows != null && !rows.isEmpty()) {
                        attributes.put("initialRows", rows);
                    }

                    // 获取 RSA 加密的密码参数，使用 Session 中的私钥解密
                    String encryptedPassword = servletRequest.getParameter("password");
                    String keyId = servletRequest.getParameter("keyId");
                    if (encryptedPassword != null && !encryptedPassword.isEmpty()) {
                        try {
                            String password = RsaSessionHelper.decryptWithSessionKey(httpSession, encryptedPassword, keyId);
                            if (password != null) {
                                attributes.put("sshPassword", password);
                            }
                        } catch (Exception e) {
                            log.warn("WebSSH: WebSocket 握手时密码解密失败", e);
                        }
                    }

                    return true;
                }
            }
            return false;
        }

        @Override
        public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                   WebSocketHandler wsHandler, Exception exception) {
        }
    }

    /**
     * 判断当前 JVM 是否运行在 Windows 上
     */
    private static boolean isWindowsOs() {
        return System.getProperty("os.name", "").toLowerCase().contains("windows");
    }
}
