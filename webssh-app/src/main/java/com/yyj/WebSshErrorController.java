package com.yyj;

import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.webmvc.error.ErrorController;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;

/**
 * 全局错误处理器
 * 覆盖 Spring Boot 默认的 Whitelabel Error Page，
 * 将所有未匹配的请求（含 404）重定向到 WebSSH 首页，避免暴露错误详情。
 *
 * @author yyj
 */
@Controller
public class WebSshErrorController implements ErrorController {
    private static final Logger log = LoggerFactory.getLogger(WebSshErrorController.class);

    /**
     * WebSSH 界面访问路径前缀（对应 application.yml 中 webssh.context-path）
     */
    @Value("${webssh.context-path:/webssh}")
    private String contextPath;

    /**
     * 处理 /error 请求，重定向到 WebSSH 首页
     */
    @RequestMapping("/error")
    public String handleError(HttpServletRequest request) {
        Object status = request.getAttribute("jakarta.servlet.error.status_code");
        Object path = request.getAttribute("jakarta.servlet.error.request_uri");
        log.debug("全局错误处理：status={}, path={}", status, path);

        // 重定向到 WebSSH 首页（相对站点根的绝对路径），由前端/登录拦截器接管
        return "redirect:" + normalizeContextPath(contextPath) + "/index.html";
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
