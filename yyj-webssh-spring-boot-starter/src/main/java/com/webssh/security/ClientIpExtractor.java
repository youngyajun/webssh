package com.webssh.security;

import com.webssh.config.WebSshProperties;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * 客户端 IP 提取器
 * 从 {@link HttpServletRequest} 中提取客户端真实 IP，供 {@link LoginAttemptService} 基于 IP 的限制使用。
 *
 * <p>本类属于 starter 层（依赖 servlet API），桥接 core 层 servlet-free 的 LoginAttemptService
 * 与 HTTP 请求。从原 LoginAttemptService.getClientIp 方法拆分而来。</p>
 *
 * <p>策略说明：
 * 默认直接使用 request.getRemoteAddr()，不信任 X-Forwarded-For 等转发头，
 * 防止攻击者伪造头绕过 IP 锁定。
 * 仅当 webssh.login-security.trust-forwarded-for=true 时才读取转发头
 * （适用于确信前端有受信反向代理且需要透传真实客户端 IP 的部署场景）。</p>
 *
 * @author webssh
 */
@Service
public class ClientIpExtractor {
    @Autowired
    private WebSshProperties properties;

    /**
     * 从请求中提取客户端真实 IP
     *
     * @param request HTTP 请求
     * @return 客户端 IP 字符串
     */
    public String extract(HttpServletRequest request) {
        if (properties.getLoginSecurity().isTrustForwardedFor()) {
            String ip = request.getHeader("X-Forwarded-For");
            if (ip != null && !ip.isEmpty() && !"unknown".equalsIgnoreCase(ip)) {
                // X-Forwarded-For 可能包含多个 IP，取第一个（最原始客户端）
                int comma = ip.indexOf(',');
                if (comma > 0) {
                    ip = ip.substring(0, comma);
                }
                return ip.trim();
            }
            ip = request.getHeader("X-Real-IP");
            if (ip != null && !ip.isEmpty() && !"unknown".equalsIgnoreCase(ip)) {
                return ip.trim();
            }
            ip = request.getHeader("Proxy-Client-IP");
            if (ip != null && !ip.isEmpty() && !"unknown".equalsIgnoreCase(ip)) {
                return ip.trim();
            }
            ip = request.getHeader("WL-Proxy-Client-IP");
            if (ip != null && !ip.isEmpty() && !"unknown".equalsIgnoreCase(ip)) {
                return ip.trim();
            }
        }
        return request.getRemoteAddr();
    }
}
