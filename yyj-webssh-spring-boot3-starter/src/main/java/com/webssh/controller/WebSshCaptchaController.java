package com.webssh.controller;

import cloud.tianai.captcha.application.ImageCaptchaApplication;
import cloud.tianai.captcha.application.vo.ImageCaptchaVO;
import cloud.tianai.captcha.common.constant.CaptchaTypeConstant;
import cloud.tianai.captcha.common.response.ApiResponse;
import cloud.tianai.captcha.generator.common.model.dto.GenerateParam;
import cloud.tianai.captcha.validator.common.model.dto.ImageCaptchaTrack;
import com.webssh.config.WebSshProperties;
import com.webssh.security.CaptchaSecurityService;
import com.webssh.security.ClientIpExtractor;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * WebSSH 旋转验证码控制器（tianai-captcha）
 *
 * <p>提供验证码生成与校验接口，符合 tianai-captcha 默认接口规范：
 * <ul>
 *   <li>生成：POST /captcha/get，返回 {code:200, data:{}}</li>
 *   <li>校验：POST /captcha/check，返回 {code:200, data:{token:xxx}} / {code:500, msg:'xxx'}</li>
 * </ul>
 *
 * <p>校验成功后返回 token（即验证码 ID），前端登录时携带该 token 进行二次校验。
 *
 * <p>旋转验证码的答案空间有限（容错 ±2%，穷举约 20 次），单靠“每个 ID 只能校验一次”
 * 无法阻止“循环取码—猜角度”爆破，因此本控制器额外依赖 {@link CaptchaSecurityService}：
 * 校验失败按 IP 累计并在超阈值后同时封禁取码与校验，封禁时长随重复触发逐级加倍；
 * 校验成功后签发一次性、绑定签发 IP 的票据，登录二次校验时立即作废。
 *
 * @author webssh
 */
@RestController
@RequestMapping("${webssh.context-path:/webssh}/captcha")
public class WebSshCaptchaController {

    private static final Logger log = LoggerFactory.getLogger(WebSshCaptchaController.class);

    @Autowired
    private ImageCaptchaApplication imageCaptchaApplication;

    @Autowired
    private WebSshProperties properties;

    @Autowired
    private ClientIpExtractor clientIpExtractor;

    @Autowired
    private CaptchaSecurityService captchaSecurityService;

    /** 按 IP 统计 /captcha/get 的固定分钟窗口访问次数（[窗口起始时间戳, 计数]），防内存/CPU DoS */
    private final Map<String, long[]> captchaGetAccessMap = new ConcurrentHashMap<>();

    /** 按 IP 统计 /captcha/check 的固定分钟窗口访问次数，防旋转角度自动化爆破 */
    private final Map<String, long[]> captchaCheckAccessMap = new ConcurrentHashMap<>();

    /**
     * 固定 1 分钟窗口的按 IP 限流。max &lt;= 0 或 ip 为空时不限流。
     * 与 WebSshAuthController 的公钥限流采用一致策略。
     */
    private boolean isRateLimited(Map<String, long[]> accessMap, String ip, int max, String endpoint) {
        if (max <= 0 || ip == null) {
            return false;
        }
        long now = System.currentTimeMillis();
        long windowStart = now - (now % 60_000L);
        long[] rec = accessMap.compute(ip, (k, v) -> {
            if (v == null || v[0] != windowStart) {
                return new long[]{windowStart, 1L};
            }
            v[1]++;
            return v;
        });
        // 机会性清理过期窗口，限制 Map 内存占用
        if (accessMap.size() > 10_000) {
            accessMap.entrySet().removeIf(e -> e.getValue()[0] != windowStart);
        }
        if (rec[1] > max) {
            log.warn("WebSSH: IP {} 请求 {} 过于频繁（{} 次/分钟，上限 {}），已限流", ip, endpoint, rec[1], max);
            return true;
        }
        return false;
    }

    /**
     * 校验失败封禁响应：该 IP 的“取码—校验”循环被临时中断，直到封禁到期。
     * 这是缓解自动化爆破（答案空间约 20 次穷举）的主要手段。
     */
    private Map<String, Object> lockedResponse(CaptchaSecurityService.AttemptStatus status) {
        Map<String, Object> result = new HashMap<>();
        result.put("code", 429);
        result.put("msg", "验证码校验失败次数过多，请稍后再试");
        result.put("lockRemainingSeconds", status.getLockRemainingSeconds());
        return result;
    }

    /**
     * 生成旋转验证码
     */
    @PostMapping("/get")
    public Map<String, Object> getCaptcha(HttpServletRequest request) {
        Map<String, Object> result = new HashMap<>();
        String clientIp = clientIpExtractor.extract(request);
        // 校验失败次数过多时连取码一起封禁，彻底卡住“取码—猜角度”循环
        CaptchaSecurityService.AttemptStatus lockStatus = captchaSecurityService.checkLocked(clientIp);
        if (lockStatus.isLocked()) {
            return lockedResponse(lockStatus);
        }
        // 未认证接口：每次生成都会向本地缓存写入待校验数据，限流防内存/CPU DoS
        if (isRateLimited(captchaGetAccessMap, clientIp,
                properties.getCaptcha().getGetMaxPerMinute(), "/captcha/get")) {
            result.put("code", 429);
            result.put("msg", "请求过于频繁，请稍后再试");
            return result;
        }
        if (!properties.getCaptcha().isEnabled()) {
            result.put("code", 200);
            result.put("data", Collections.emptyMap());
            result.put("captchaEnabled", false);
            return result;
        }
        // 开启混淆：旋转验证码下 obfuscate 会将模板随机旋转一个角度，增加机器识别难度
        // 校验仍只认真实旋转角度，前端 tac 组件根据返回的 type 自动渲染旋转样式
        GenerateParam captchaParam = GenerateParam.builder()
                .type(CaptchaTypeConstant.ROTATE)
                .obfuscate(true)
                .build();
        ApiResponse<ImageCaptchaVO> response = imageCaptchaApplication.generateCaptcha(captchaParam);
        if (response.isSuccess()) {
            result.put("code", 200);
            result.put("data", response.getData());
        } else {
            result.put("code", 500);
            result.put("msg", response.getMsg());
        }
        return result;
    }

    /**
     * 校验旋转验证码
     * 校验成功返回 token（即验证码 ID），供前端登录时二次校验使用
     */
    @PostMapping("/check")
    public Map<String, Object> checkCaptcha(@RequestBody CaptchaCheckDTO dto, HttpServletRequest request) {
        Map<String, Object> result = new HashMap<>();
        String clientIp = clientIpExtractor.extract(request);
        // 失败封禁优先于限流：命中后该 IP 无法再取码/校验，爆破成本大幅上升
        CaptchaSecurityService.AttemptStatus lockStatus = captchaSecurityService.checkLocked(clientIp);
        if (lockStatus.isLocked()) {
            return lockedResponse(lockStatus);
        }
        // 未认证接口：旋转验证码答案空间较小，限流拖慢“取码-猜角度”自动化爆破
        if (isRateLimited(captchaCheckAccessMap, clientIp,
                properties.getCaptcha().getCheckMaxPerMinute(), "/captcha/check")) {
            result.put("code", 429);
            result.put("msg", "请求过于频繁，请稍后再试");
            return result;
        }
        if (dto == null || dto.getId() == null || dto.getId().isEmpty() || dto.getData() == null) {
            // 残缺请求按校验失败处理，防止用来探测或绕过失败计数
            CaptchaSecurityService.AttemptStatus status = captchaSecurityService.recordFailure(clientIp);
            if (status.isLocked()) {
                return lockedResponse(status);
            }
            result.put("code", 500);
            result.put("msg", "校验参数错误");
            return result;
        }
        ApiResponse<?> response;
        try {
            response = imageCaptchaApplication.matching(dto.getId(), dto.getData());
        } catch (Exception e) {
            // 异常输入同样按校验失败计数，避免被用于绕过失败封禁
            log.warn("WebSSH: IP {} 验证码校验异常: {}", clientIp, e.getMessage());
            CaptchaSecurityService.AttemptStatus status = captchaSecurityService.recordFailure(clientIp);
            if (status.isLocked()) {
                return lockedResponse(status);
            }
            result.put("code", 500);
            result.put("msg", "校验失败，请重试");
            return result;
        }
        if (response.isSuccess()) {
            // 校验成功：清除该 IP 的失败计数，并签发一次性、绑定 IP 的二次验证票据
            captchaSecurityService.recordSuccess(clientIp);
            captchaSecurityService.issueToken(dto.getId(), clientIp);
            result.put("code", 200);
            result.put("data", Collections.singletonMap("token", dto.getId()));
            return result;
        }
        CaptchaSecurityService.AttemptStatus failStatus = captchaSecurityService.recordFailure(clientIp);
        if (failStatus.isLocked()) {
            return lockedResponse(failStatus);
        }
        result.put("code", 500);
        result.put("msg", response.getMsg());
        result.put("remainingAttempts", failStatus.getRemainingAttempts());
        return result;
    }

    public static class CaptchaCheckDTO {
        private String id;
        private ImageCaptchaTrack data;

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public ImageCaptchaTrack getData() {
            return data;
        }

        public void setData(ImageCaptchaTrack data) {
            this.data = data;
        }
    }
}