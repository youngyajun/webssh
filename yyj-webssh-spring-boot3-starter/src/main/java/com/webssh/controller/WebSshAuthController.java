package com.webssh.controller;

import cloud.tianai.captcha.application.ImageCaptchaApplication;
import cloud.tianai.captcha.spring.plugins.secondary.SecondaryVerificationApplication;
import com.webssh.config.WebSshProperties;
import com.webssh.security.ClientIpExtractor;
import com.webssh.security.LoginAttemptService;
import com.webssh.ssh.SshService;
import com.webssh.util.RsaSessionHelper;
import com.webssh.util.RsaUtil;
import com.webssh.websocket.WebSshWebSocketHandler;
import com.webssh.websocket.WsTicketStore;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.*;

import java.security.KeyPair;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

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

    @Autowired
    private ClientIpExtractor clientIpExtractor;

    @Autowired
    private ImageCaptchaApplication imageCaptchaApplication;

    @Autowired
    private WebSshWebSocketHandler webSshWebSocketHandler;

    @Autowired
    private WsTicketStore wsTicketStore;

    /** 按 IP 统计 /auth/public-key 的固定分钟窗口访问次数（[窗口起始时间戳, 计数]），防 RSA 生成 DoS */
    private final Map<String, long[]> publicKeyAccessMap = new ConcurrentHashMap<>();

    /**
     * 判断指定 IP 是否已触发公钥接口限流（固定 1 分钟窗口）。
     * webssh.security.public-key-max-per-minute &lt;= 0 时关闭限流。
     * <p>已登录用户走宽松上限（基础值×20）：正常操作（多标签、文件会话、断线重连）
     * 会频繁获取公钥，严格限流会误伤已认证用户，导致密码无法加密、SSH 认证失败。
     * DoS 防护主要针对未认证的频繁密钥生成请求。</p>
     */
    private boolean isPublicKeyRateLimited(String ip, boolean authenticated) {
        int base = properties.getSecurity().getPublicKeyMaxPerMinute();
        if (base <= 0 || ip == null) {
            return false;
        }
        int max = authenticated ? base * 20 : base;
        long now = System.currentTimeMillis();
        long windowStart = now - (now % 60_000L);
        long[] rec = publicKeyAccessMap.compute(ip, (k, v) -> {
            if (v == null || v[0] != windowStart) {
                return new long[]{windowStart, 1L};
            }
            v[1]++;
            return v;
        });
        // 机会性清理过期窗口，限制 Map 内存占用
        if (publicKeyAccessMap.size() > 10_000) {
            publicKeyAccessMap.entrySet().removeIf(e -> e.getValue()[0] != windowStart);
        }
        if (rec[1] > max) {
            log.warn("WebSSH: IP {} 请求公钥过于频繁（{} 次/分钟，上限 {}），已限流", ip, rec[1], max);
            return true;
        }
        return false;
    }

    /**
     * 获取 RSA 公钥
     * 每次请求生成新的密钥对，私钥以 keyId 为索引存入 Session，公钥和 keyId 返回前端用于加密密码
     * 同时返回当前 IP 的登录锁定状态，便于前端在页面加载时展示锁定倒计时
     */
    @GetMapping("/public-key")
    public Map<String, Object> publicKey(HttpSession session, HttpServletRequest request) {
        Map<String, Object> result = new HashMap<>();
        String clientIp = clientIpExtractor.extract(request);
        // 已登录用户正常操作（多标签/文件会话/重连）会频繁取公钥，限流阀值需宽松；
        // 未认证请求（如登录页）仍按严格阀值限制，防止 CPU/内存 DoS
        Boolean loggedInFlag = (Boolean) session.getAttribute("webssh_logged_in");
        boolean authenticated = loggedInFlag != null && loggedInFlag;
        if (isPublicKeyRateLimited(clientIp, authenticated)) {
            result.put("code", 429);
            result.put("msg", "请求过于频繁，请稍后再试");
            return result;
        }
        try {
            KeyPair keyPair = RsaUtil.generateKeyPair();
            // 私钥存入 Session 映射表（限制表大小防止堆积），返回 keyId 供前端回传
            int maxSize = properties.getSecurity().getRsaKeyMapMaxSize();
            String keyId = RsaSessionHelper.storePrivateKey(session, keyPair.getPrivate(), maxSize);
            String publicKeyBase64 = RsaUtil.getPublicKeyBase64(keyPair.getPublic());
            result.put("code", 200);
            result.put("publicKey", publicKeyBase64);
            result.put("keyId", keyId);
            // 附带验证码开关，前端据此决定是否弹出旋转验证
            result.put("captchaEnabled", properties.getCaptcha().isEnabled());
            // 附带登录锁定状态
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
        String clientIp = clientIpExtractor.extract(request);

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

        // 旋转验证码二次校验（开启时必须校验通过才能继续登录）
        if (properties.getCaptcha().isEnabled()) {
            String captchaValidation = params.get("captchaValidation");
            if (captchaValidation == null || captchaValidation.isEmpty()) {
                result.put("code", 401);
                result.put("msg", "请先完成旋转验证");
                return result;
            }
            boolean valid = ((SecondaryVerificationApplication) imageCaptchaApplication)
                    .secondaryVerification(captchaValidation);
            if (!valid) {
                result.put("code", 401);
                result.put("msg", "旋转验证失败或已过期，请重新验证");
                return result;
            }
        }

        if (username == null || encryptedPassword == null) {
            result.put("code", 400);
            result.put("msg", "用户名或密码不能为空");
            return result;
        }

        // 使用 keyId 从 Session 映射表中取出私钥解密密码（一次性使用）
        String password;
        try {
            password = RsaSessionHelper.decryptWithSessionKey(session, encryptedPassword, keyId);
        } catch (Exception e) {
            log.warn("密码解密失败", e);
            result.put("code", 401);
            result.put("msg", "密码解密失败，请刷新页面重试");
            return result;
        }

        if (authenticate(username, password)) {
            // 登录成功，清除失败记录
            loginAttemptService.recordSuccess(clientIp);
            // 防止攻击者预先固定 JSESSIONID 后诱导用户登录。
            request.changeSessionId();
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
     * 校验账号密码是否匹配任一已配置的管理账号
     * 仅与通过密码强度校验的有效账号比对（getValidAccounts），
     * 弱密码或字段缺失的账号在启动时已被标记为无效，无法用于登录。
     * 使用常量时间比较，降低时序攻击风险。
     */
    private boolean authenticate(String username, String password) {
        if (username == null || password == null) {
            return false;
        }
        for (WebSshProperties.Account account : properties.getValidAccounts()) {
            if (username.equals(account.getUsername())
                    && constantTimeEquals(password, account.getPassword())) {
                return true;
            }
        }
        return false;
    }

    /**
     * 常量时间字符串比较，避免基于耗时的密码猜测
     */
    private boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        if (a.length() != b.length()) {
            return false;
        }
        int diff = 0;
        for (int i = 0; i < a.length(); i++) {
            diff |= a.charAt(i) ^ b.charAt(i);
        }
        return diff == 0;
    }

    /**
     * 签发 WebSocket 一次性连接票据
     * <p>前端先用 RSA 公钥加密 SSH 密码，再通过本接口（请求体携带密文，不走 URL）
     * 换取一个短期、一次性票据；随后建立终端 WebSocket 时 URL 仅携带该票据，
     * 避免密码密文出现在 URL（日志/代理/Referer）中。</p>
     * <p>本接口位于 {@code /auth/**}（被认证拦截器放行），故在此显式校验登录状态。</p>
     */
    @PostMapping("/ws-ticket")
    public Map<String, Object> wsTicket(@RequestBody Map<String, String> params, HttpSession session) {
        Map<String, Object> result = new HashMap<>();
        Boolean loggedIn = (Boolean) session.getAttribute("webssh_logged_in");
        if (loggedIn == null || !loggedIn) {
            result.put("code", 401);
            result.put("msg", "未登录或会话已过期");
            return result;
        }
        String encryptedPassword = params.get("password");
        String keyId = params.get("keyId");
        if (encryptedPassword == null || encryptedPassword.isEmpty()) {
            result.put("code", 400);
            result.put("msg", "缺少加密密码");
            return result;
        }
        try {
            String password = RsaSessionHelper.decryptWithSessionKey(session, encryptedPassword, keyId);
            String ticket = wsTicketStore.issue(password);
            result.put("code", 200);
            result.put("ticket", ticket);
        } catch (Exception e) {
            log.warn("WS 票据签发失败：密码解密错误", e);
            result.put("code", 401);
            result.put("msg", "密码解密失败，请刷新页面重试");
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
        webSshWebSocketHandler.closeSessionsForHttpSession(session.getId());
        session.invalidate();
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
