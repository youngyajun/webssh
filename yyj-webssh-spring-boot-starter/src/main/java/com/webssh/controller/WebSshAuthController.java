package com.webssh.controller;

import com.webssh.config.WebSshProperties;
import com.webssh.controller.WebSshFileController;
import com.webssh.security.LoginAttemptService;
import com.webssh.ssh.SshService;
import com.webssh.util.RsaUtil;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.security.KeyPair;
import java.util.HashMap;
import java.util.Map;

/**
 * WebSSH 认证控制器
 * 处理登录/登出请求
 *
 * @author webssh
 */
@RestController
@RequestMapping("${webssh.context-path:/webssh}/auth")
public class WebSshAuthController {
    private static final Logger log = LoggerFactory.getLogger(WebSshAuthController.class);

    @Autowired
    private WebSshProperties properties;

    @Autowired
    private SshService sshService;

    @Autowired
    private LoginAttemptService loginAttemptService;

    /**
     * 获取 RSA 公钥
     * 每次请求生成新的密钥对，私钥以 keyId 为索引存入 Session，公钥和 keyId 返回前端用于加密密码
     * 同时返回当前 IP 的登录锁定状态，便于前端在页面加载时展示锁定倒计时
     */
    @GetMapping("/public-key")
    public Map<String, Object> publicKey(HttpSession session, HttpServletRequest request) {
        Map<String, Object> result = new HashMap<>();
        try {
            KeyPair keyPair = RsaUtil.generateKeyPair();
            // 私钥存入 Session 映射表，返回 keyId 供前端回传
            String keyId = RsaUtil.storePrivateKey(session, keyPair.getPrivate());
            String publicKeyBase64 = RsaUtil.getPublicKeyBase64(keyPair.getPublic());
            result.put("code", 200);
            result.put("publicKey", publicKeyBase64);
            result.put("keyId", keyId);
            // 附带登录锁定状态
            String clientIp = loginAttemptService.getClientIp(request);
            LoginAttemptService.LockStatus status = loginAttemptService.checkLocked(clientIp);
            result.put("locked", status.isLocked());
            if (status.isLocked()) {
                result.put("lockRemainingSeconds", status.getLockRemainingSeconds());
            }
        } catch (Exception e) {
            log.error("生成 RSA 密钥对失败", e);
            result.put("code", 500);
            result.put("msg", "获取公钥失败，请刷新页面重试");
        }
        return result;
    }

    /**
     * 登录
     * 包含基于 IP 的登录失败次数限制与锁定，防止密码被暴力破解
     */
    @PostMapping("/login")
    public Map<String, Object> login(@RequestBody Map<String, String> params, HttpSession session,
                                     HttpServletRequest request) {
        Map<String, Object> result = new HashMap<>();
        String clientIp = loginAttemptService.getClientIp(request);

        // 先检查该 IP 是否已被锁定
        LoginAttemptService.LockStatus lockStatus = loginAttemptService.checkLocked(clientIp);
        if (lockStatus.isLocked()) {
            result.put("code", 429);
            result.put("msg", "登录失败次数过多，请稍后再试");
            result.put("lockRemainingSeconds", lockStatus.getLockRemainingSeconds());
            return result;
        }

        String username = params.get("username");
        String encryptedPassword = params.get("password");
        String keyId = params.get("keyId");

        if (username == null || encryptedPassword == null) {
            result.put("code", 400);
            result.put("msg", "用户名或密码不能为空");
            return result;
        }

        // 使用 keyId 从 Session 映射表中取出私钥解密密码（一次性使用）
        String password;
        try {
            password = RsaUtil.decryptWithSessionKey(session, encryptedPassword, keyId);
        } catch (Exception e) {
            log.warn("密码解密失败", e);
            result.put("code", 401);
            result.put("msg", "密码解密失败，请刷新页面重试");
            return result;
        }

        if (username.equals(properties.getUsername()) && password.equals(properties.getPassword())) {
            // 登录成功，清除失败记录
            loginAttemptService.recordSuccess(clientIp);
            session.setAttribute("webssh_logged_in", true);
            session.setAttribute("webssh_user", username);
            result.put("code", 200);
            result.put("msg", "登录成功");
            result.put("contextPath", properties.getContextPath());
            return result;
        }

        // 登录失败，记录失败次数并返回最新状态
        LoginAttemptService.LockStatus failStatus = loginAttemptService.recordFailure(clientIp);
        if (failStatus.isLocked()) {
            result.put("code", 429);
            result.put("msg", "用户名或密码错误次数过多，已锁定");
            result.put("lockRemainingSeconds", failStatus.getLockRemainingSeconds());
        } else {
            result.put("code", 401);
            result.put("msg", "用户名或密码错误");
            result.put("remainingAttempts", failStatus.getRemainingAttempts());
        }
        return result;
    }

    /**
     * 登出
     */
    @PostMapping("/logout")
    public Map<String, Object> logout(HttpSession session) {
        Map<String, Object> result = new HashMap<>();
        // 清理所有文件管理会话（多标签场景），避免 SSH 连接泄漏
        WebSshFileController.closeAllFileSessions(session, sshService);
        session.removeAttribute("webssh_logged_in");
        session.removeAttribute("webssh_user");
        result.put("code", 200);
        result.put("msg", "登出成功");
        return result;
    }

    /**
     * 检查登录状态
     */
    @GetMapping("/check")
    public Map<String, Object> check(HttpSession session) {
        Map<String, Object> result = new HashMap<>();
        Boolean loggedIn = (Boolean) session.getAttribute("webssh_logged_in");
        if (loggedIn != null && loggedIn) {
            result.put("code", 200);
            result.put("loggedIn", true);
            result.put("username", session.getAttribute("webssh_user"));
        } else {
            result.put("code", 401);
            result.put("loggedIn", false);
        }
        return result;
    }
}
