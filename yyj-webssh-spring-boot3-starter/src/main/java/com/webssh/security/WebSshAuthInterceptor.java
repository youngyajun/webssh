package com.webssh.security;

import com.webssh.config.WebSshProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * WebSSH 认证拦截器
 * 拦截所有需要登录才能访问的路径（API、index.html 等），
 * 校验 HttpSession 中的 webssh_logged_in 标记，未登录则返回 401 或重定向到登录页。
 *
 * 放行路径由 WebMvcConfigurer 注册时通过 excludePathPatterns 指定，通常包括：
 * - 登录页 login.html
 * - /auth/** 接口（public-key、login、check、logout）
 * - 静态资源（images、js、style）
 *
 * @author webssh
 */
public class WebSshAuthInterceptor implements HandlerInterceptor {
    private final WebSshProperties properties;

    public WebSshAuthInterceptor(WebSshProperties properties) {
        this.properties = properties;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        HttpSession session = request.getSession(false);
        Boolean loggedIn = session != null ? (Boolean) session.getAttribute("webssh_logged_in") : null;
        if (loggedIn != null && loggedIn) {
            return true;
        }
        // 未登录：API/JSON 请求返回 401 JSON，页面请求重定向到登录页
        String uri = request.getRequestURI();
        boolean isApiRequest = uri.contains("/api/");
        String accept = request.getHeader("Accept");
        boolean wantsJson = accept != null && accept.contains("application/json");
        if (isApiRequest || wantsJson) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/json;charset=UTF-8");
            response.getWriter().write("{\"code\":401,\"msg\":\"未登录或会话已过期\"}");
        } else {
            String contextPath = properties.getContextPath();
            if (!contextPath.endsWith("/")) {
                contextPath = contextPath + "/";
            }
            response.sendRedirect(request.getContextPath() + contextPath + "login.html");
        }
        return false;
    }
}
