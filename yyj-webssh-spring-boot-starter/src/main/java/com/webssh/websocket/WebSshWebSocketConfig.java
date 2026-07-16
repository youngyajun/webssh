package com.webssh.websocket;

import com.webssh.config.WebSshProperties;
import com.webssh.util.RsaUtil;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;

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
     */
    private static class WebSshHandshakeInterceptor implements HandshakeInterceptor {
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
                            String password = RsaUtil.decryptWithSessionKey(httpSession, encryptedPassword, keyId);
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
}
