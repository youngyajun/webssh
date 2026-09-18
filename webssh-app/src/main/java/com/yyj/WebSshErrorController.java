package com.yyj;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.webmvc.error.ErrorController;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 全局错误处理器
 * 覆盖 Spring Boot 默认的 Whitelabel Error Page，避免暴露错误详情。
 *
 * 分两种响应：
 * 1. API/JSON 请求（路径含 /api/、XHR、Accept 含 application/json）→ 返回 JSON 错误体。
 *    否则容器级错误（如上传超限时容器直接返回 413，请求根本进不到控制器）会以 HTML/重定向
 *    的形式回到前端，前端 JSON.parse 失败只能提示“响应解析失败”，无法定位原因。
 * 2. 页面请求 → 重定向到 WebSSH 首页，由前端/登录拦截器接管。
 *
 * @author yyj
 */
@Controller
public class WebSshErrorController implements ErrorController {
    private static final Logger log = LoggerFactory.getLogger(WebSshErrorController.class);

    /** Servlet 6 错误属性名（javax.* 已更名为 jakarta.*） */
    private static final String ATTR_STATUS = "jakarta.servlet.error.status_code";
    private static final String ATTR_URI = "jakarta.servlet.error.request_uri";
    private static final String ATTR_MESSAGE = "jakarta.servlet.error.message";

    /** HTTP 302 Found：页面请求重定向到首页 */
    private static final int SC_FOUND = 302;

    /**
     * WebSSH 界面访问路径前缀（对应 application.yml 中 webssh.context-path）
     */
    @Value("${webssh.context-path:/webssh}")
    private String contextPath;

    /**
     * 处理 /error 请求：API 请求返回 JSON，页面请求重定向到首页
     */
    @RequestMapping("/error")
    public ResponseEntity<?> handleError(HttpServletRequest request) {
        int status = resolveStatus(request);
        String uri = attr(request, ATTR_URI);
        String servletMessage = attr(request, ATTR_MESSAGE);

        if (isApiRequest(request, uri)) {
            // 原始错误信息只落日志，不回显给客户端，避免泄露内部实现
            log.warn("全局错误处理：返回 JSON status={}, uri={}, message={}", status, uri, servletMessage);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("code", status);
            body.put("msg", buildMessage(status));
            return ResponseEntity.status(status)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body);
        }

        log.debug("全局错误处理：重定向到首页 status={}, uri={}", status, uri);
        return ResponseEntity.status(SC_FOUND)
                .location(URI.create(request.getContextPath() + normalizeContextPath(contextPath) + "/index.html"))
                .build();
    }

    /**
     * 是否为 API/JSON 请求：
     * - 原始请求 URI 含 /api/（WebSSH 所有接口路径）
     * - 显式声明 Accept: application/json
     * - XHR 标识 X-Requested-With: XMLHttpRequest
     */
    private boolean isApiRequest(HttpServletRequest request, String uri) {
        if (uri != null && uri.contains("/api/")) {
            return true;
        }
        String accept = request.getHeader("Accept");
        if (accept != null && accept.contains("application/json")) {
            return true;
        }
        return "XMLHttpRequest".equalsIgnoreCase(request.getHeader("X-Requested-With"));
    }

    /**
     * 按状态码生成给客户端的提示文案（不含内部实现细节）
     */
    private String buildMessage(int status) {
        switch (status) {
            case 400:
                return "请求参数错误";
            case 401:
                return "未登录或会话已过期";
            case 403:
                return "没有访问权限";
            case 404:
                return "接口不存在";
            case 405:
                return "请求方法不被允许";
            case 408:
                return "请求超时";
            case 413:
                return "上传文件超过大小限制，请调大 spring.servlet.multipart.max-file-size / "
                        + "max-request-size，以及代理层（如 Nginx）的 client_max_body_size";
            case 502:
            case 503:
            case 504:
                return "后端服务不可用或响应超时";
            default:
                return "服务端处理失败（HTTP " + status + "）";
        }
    }

    /**
     * 解析 Servlet 容器写入的错误状态码，缺失或非法时回退 500
     */
    private int resolveStatus(HttpServletRequest request) {
        Object status = request.getAttribute(ATTR_STATUS);
        if (status instanceof Integer value) {
            return value;
        }
        if (status instanceof String text) {
            try {
                return Integer.parseInt(text.trim());
            } catch (NumberFormatException ignored) {
                // 非法值走默认回退
            }
        }
        return 500;
    }

    private String attr(HttpServletRequest request, String name) {
        Object value = request.getAttribute(name);
        return value == null ? "" : String.valueOf(value);
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
}
