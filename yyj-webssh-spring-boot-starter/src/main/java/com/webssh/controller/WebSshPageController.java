package com.webssh.controller;

import com.webssh.config.WebSshProperties;
import com.webssh.controller.WebSshFileController;
import com.webssh.ssh.SshService;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;

import java.io.IOException;

/**
 * WebSSH 页面控制器
 * 负责根路径重定向和登出，静态资源由 WebMvcConfigurer 自动映射
 *
 * @author webssh
 */
@Controller
@RequestMapping("${webssh.context-path:/webssh}")
public class WebSshPageController {
    @Autowired
    private WebSshProperties properties;

    @Autowired
    private SshService sshService;

    /**
     * 访问 /webssh 重定向到 /webssh/index.html
     */
    @GetMapping
    public void index(HttpServletResponse response) throws IOException {
        response.sendRedirect(properties.getContextPath() + "/index.html");
    }

    /**
     * 登出，清除session后重定向到登录页
     */
    @GetMapping("/logout")
    public void logout(HttpSession session, HttpServletResponse response) throws IOException {
        // 清理所有文件管理会话（多标签场景），避免 SSH 连接泄漏
        WebSshFileController.closeAllFileSessions(session, sshService);
        session.removeAttribute("webssh_logged_in");
        session.removeAttribute("webssh_user");
        // 使用相对路径重定向，兼容开发环境代理前缀（如 /dev-api）
        response.sendRedirect("login.html");
    }
}
