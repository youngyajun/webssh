package com.webssh.security;

import com.webssh.config.WebSshProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * WebSSH 安全响应头过滤器
 * <p>为 WebSSH 相关响应统一附加安全响应头（点击劫持、MIME 嗅探、CSP、Referrer 泄露等防护）。
 * 项目未引入 Spring Security，故通过本过滤器补齐基线安全头。</p>
 *
 * <p>所有行为均可通过 {@code webssh.security.*} 配置：
 * <ul>
 *   <li>{@code headers-enabled=false} 可整体关闭本过滤器；</li>
 *   <li>{@code content-security-policy} 留空则不下发 CSP；</li>
 *   <li>{@code hsts-enabled=true} 才下发 HSTS（默认关闭以兼容 HTTP 部署，不强制 HTTPS）。</li>
 * </ul>
 *
 * @author webssh
 */
public class WebSshSecurityHeadersFilter extends OncePerRequestFilter {

    private final WebSshProperties properties;

    public WebSshSecurityHeadersFilter(WebSshProperties properties) {
        this.properties = properties;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        WebSshProperties.Security security = properties.getSecurity();
        if (security != null && security.isHeadersEnabled()) {
            applyHeaders(response, security);
        }
        filterChain.doFilter(request, response);
    }

    /**
     * 附加安全响应头。使用 setHeader 前先判断是否已存在，避免覆盖下游显式设置的同名头。
     */
    private void applyHeaders(HttpServletResponse response, WebSshProperties.Security security) {
        // 禁止浏览器 MIME 类型嗅探，避免把上传/下载内容当作脚本执行
        setIfAbsent(response, "X-Content-Type-Options", "nosniff");
        // 点击劫持防护（对不支持 CSP frame-ancestors 的旧浏览器兜底）
        setIfAbsent(response, "X-Frame-Options", "SAMEORIGIN");
        // 不发送 Referer，避免 URL 中的敏感信息（如一次性票据）泄露到第三方
        setIfAbsent(response, "Referrer-Policy", "no-referrer");
        // 关闭本应用用不到的浏览器高风险特性
        setIfAbsent(response, "Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()");
        // 限制跨源窗口可访问的内容，缓解 Spectre 类跨源信息泄露
        setIfAbsent(response, "Cross-Origin-Resource-Policy", "same-origin");

        String csp = security.getContentSecurityPolicy();
        if (csp != null && !csp.trim().isEmpty()) {
            setIfAbsent(response, "Content-Security-Policy", csp.trim());
        }

        // HSTS 默认关闭：仅在部署者确证整站强制 HTTPS 时开启，避免影响必须走 HTTP 的站点
        if (security.isHstsEnabled()) {
            setIfAbsent(response, "Strict-Transport-Security",
                    "max-age=" + security.getHstsMaxAge() + "; includeSubDomains");
        }
    }

    private void setIfAbsent(HttpServletResponse response, String name, String value) {
        if (!response.containsHeader(name)) {
            response.setHeader(name, value);
        }
    }
}
