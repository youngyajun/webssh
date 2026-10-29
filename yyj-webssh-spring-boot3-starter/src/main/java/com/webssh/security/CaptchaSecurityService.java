package com.webssh.security;

import com.webssh.config.WebSshProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 旋转验证码安全服务
 *
 * <p>用于弥补旋转验证码“答案空间小 + 轨迹校验仅为启发式”的固有弱点：
 * 容错值默认 ±2%（背景 600px 时约 ±12px），穷举答案空间约需 20 次尝试，
 * 而每个验证码 ID 只能校验一次，攻击者可通过“取新 ID → 猜角度”循环在数分钟内命中。
 *
 * <p>本服务提供两道额外防线：
 * <ol>
 *   <li>按 IP 统计校验失败次数，超阈值后临时封禁该 IP 的取码与校验，
 *       且同一 IP 反复触发时封禁时长逐级加倍。</li>
 *   <li>校验成功后签发一次性票据（绑定签发 IP、带有效期），登录二次校验时立即作废，
 *       避免同一票据被跨会话、跨 IP 重放。</li>
 * </ol>
 *
 * <p>与 {@link LoginAttemptService}（登录密码防暴破）相互独立，计数不共享。
 *
 * @author webssh
 */
@Service
public class CaptchaSecurityService {
    private static final Logger log = LoggerFactory.getLogger(CaptchaSecurityService.class);

    /** 封禁级别的最大加倍次数（超过后不再增长，由 maxLockMinutes 兜底） */
    private static final int MAX_LOCK_LEVEL = 16;

    /** 失败记录 Map 达到该规模时做一次机会性清理，限制内存占用 */
    private static final int ATTEMPT_PURGE_THRESHOLD = 10_000;

    /** 票据 Map 达到该规模时做一次机会性清理，限制内存占用 */
    private static final int TICKET_PURGE_THRESHOLD = 4_096;

    /** 票据 Map 硬上限（防御大量请求绕过上层限流直接灌入） */
    private static final int TICKET_HARD_LIMIT = 20_000;

    @Autowired
    private WebSshProperties properties;

    /** 按 IP 维护验证码校验失败记录 */
    private final Map<String, AttemptInfo> attemptMap = new ConcurrentHashMap<>();

    /** 校验成功后签发的一次性票据：token（即验证码 ID）→ 票据信息 */
    private final Map<String, TicketInfo> ticketMap = new ConcurrentHashMap<>();

    /**
     * 单个 IP 的失败尝试记录
     */
    private static class AttemptInfo {
        /** 当前统计窗口内的失败次数 */
        int failCount;
        /** 当前统计窗口起始时间 */
        long windowStart;
        /** 最近一次失败时间 */
        long lastFailTime;
        /** 封禁截止时间（毫秒时间戳），0 表示未封禁 */
        long lockUntil;
        /** 封禁升级级别（第几次触发封禁，决定封禁时长） */
        int lockLevel;

        AttemptInfo() {
            this.failCount = 0;
            this.windowStart = System.currentTimeMillis();
            this.lastFailTime = 0;
            this.lockUntil = 0;
            this.lockLevel = 0;
        }
    }

    /**
     * 校验成功票据
     */
    private static class TicketInfo {
        final String ip;
        final long expireAt;

        TicketInfo(String ip, long expireAt) {
            this.ip = ip;
            this.expireAt = expireAt;
        }
    }

    /**
     * 尝试状态
     */
    public static class AttemptStatus {
        private final boolean locked;
        private final int remainingAttempts;
        private final long lockRemainingSeconds;

        AttemptStatus(boolean locked, int remainingAttempts, long lockRemainingSeconds) {
            this.locked = locked;
            this.remainingAttempts = remainingAttempts;
            this.lockRemainingSeconds = lockRemainingSeconds;
        }

        public boolean isLocked() {
            return locked;
        }

        public int getRemainingAttempts() {
            return remainingAttempts;
        }

        public long getLockRemainingSeconds() {
            return lockRemainingSeconds;
        }
    }

    /**
     * 检查指定 IP 是否已被验证码校验失败封禁
     */
    public AttemptStatus checkLocked(String ip) {
        if (!isEnabled() || ip == null) {
            return new AttemptStatus(false, Integer.MAX_VALUE, 0);
        }
        AttemptInfo info = attemptMap.get(ip);
        if (info == null) {
            return new AttemptStatus(false, maxFailAttempts(), 0);
        }
        long now = System.currentTimeMillis();
        synchronized (info) {
            if (info.lockUntil > now) {
                long remaining = (info.lockUntil - now) / 1000;
                return new AttemptStatus(true, 0, Math.max(1, remaining));
            }
            if (now - info.lastFailTime > failWindowMs()) {
                // 静默时间已超过统计窗口：清除记录（含封禁升级级别），重新开始计数
                attemptMap.remove(ip, info);
                return new AttemptStatus(false, maxFailAttempts(), 0);
            }
            if (now - info.windowStart > failWindowMs()) {
                // 滑动窗口到期，重新开窗
                info.windowStart = now;
                info.failCount = 0;
            }
            int remaining = Math.max(0, maxFailAttempts() - info.failCount);
            return new AttemptStatus(false, remaining, 0);
        }
    }

    /**
     * 记录一次验证码校验失败，超过阈值则封禁该 IP，并返回最新状态
     */
    public AttemptStatus recordFailure(String ip) {
        if (!isEnabled() || ip == null) {
            return new AttemptStatus(false, Integer.MAX_VALUE, 0);
        }
        AttemptInfo info = attemptMap.computeIfAbsent(ip, k -> new AttemptInfo());
        synchronized (info) {
            long now = System.currentTimeMillis();
            if (now - info.lastFailTime > failWindowMs()) {
                // 距上次失败已超过统计窗口，重置计数与封禁升级级别
                info.failCount = 0;
                info.lockLevel = 0;
                info.windowStart = now;
            } else if (now - info.windowStart > failWindowMs()) {
                info.windowStart = now;
                info.failCount = 0;
            }
            info.failCount++;
            info.lastFailTime = now;
            if (info.failCount >= maxFailAttempts()) {
                info.lockLevel = Math.min(info.lockLevel + 1, MAX_LOCK_LEVEL);
                long durationMs = lockDurationMs(info.lockLevel);
                info.lockUntil = now + durationMs;
                log.warn("WebSSH: IP {} 旋转验证码校验失败达到上限（{} 次），已封禁 {} 分钟（第 {} 次触发）",
                        ip, info.failCount, durationMs / 60_000L, info.lockLevel);
            }
        }
        purgeExpiredAttempts(System.currentTimeMillis());
        return checkLocked(ip);
    }

    /**
     * 记录一次验证码校验成功，清除该 IP 的失败记录（含封禁升级级别）
     */
    public void recordSuccess(String ip) {
        if (ip == null) {
            return;
        }
        attemptMap.remove(ip);
    }

    /**
     * 校验成功后签发一次性票据（票据值即验证码 ID）
     */
    public void issueToken(String captchaId, String ip) {
        if (captchaId == null || captchaId.isEmpty()) {
            return;
        }
        long now = System.currentTimeMillis();
        purgeExpiredTickets(now);
        if (ticketMap.size() >= TICKET_HARD_LIMIT) {
            log.warn("WebSSH: 旋转验证票据数量达到上限（{}），已拒绝签发新票据", TICKET_HARD_LIMIT);
            return;
        }
        ticketMap.put(captchaId, new TicketInfo(ip, now + tokenTtlMs()));
    }

    /**
     * 消费票据：校验存在性、有效期与签发 IP，无论成功与否都立即作废（一次性）
     *
     * @param token 前端回传的二次验证票据
     * @param ip    当前请求来源 IP
     * @return 票据有效返回 true，否则 false
     */
    public boolean consumeToken(String token, String ip) {
        if (token == null || token.isEmpty()) {
            return false;
        }
        TicketInfo info = ticketMap.remove(token);
        if (info == null) {
            return false;
        }
        if (info.expireAt <= System.currentTimeMillis()) {
            return false;
        }
        if (properties.getCaptcha().isTokenBindIp() && info.ip != null && ip != null
                && !info.ip.equals(ip)) {
            log.warn("WebSSH: 旋转验证票据签发 IP({}) 与使用 IP({}) 不一致，已拒绝", info.ip, ip);
            return false;
        }
        return true;
    }

    /**
     * 机会性清理已失效的失败记录，限制 Map 内存占用
     */
    private void purgeExpiredAttempts(long now) {
        if (attemptMap.size() < ATTEMPT_PURGE_THRESHOLD) {
            return;
        }
        attemptMap.entrySet().removeIf(e -> {
            AttemptInfo v = e.getValue();
            return v.lockUntil <= now && now - v.lastFailTime > failWindowMs();
        });
    }

    /**
     * 清理已过期的票据，限制 Map 内存占用
     */
    private void purgeExpiredTickets(long now) {
        if (ticketMap.size() < TICKET_PURGE_THRESHOLD) {
            return;
        }
        ticketMap.entrySet().removeIf(e -> e.getValue().expireAt <= now);
    }

    /**
     * 按封禁级别计算封禁时长：基础值随时间逐级加倍，上限 maxLockMinutes
     */
    private long lockDurationMs(int lockLevel) {
        long base = Math.max(1, lockMinutes()) * 60_000L;
        long maxMs = Math.max(1, maxLockMinutes()) * 60_000L;
        long duration = Math.min(base, maxMs);
        for (int i = 1; i < lockLevel && duration < maxMs; i++) {
            long doubled = duration * 2;
            duration = (doubled > maxMs || doubled <= 0) ? maxMs : doubled;
        }
        return duration;
    }

    private boolean isEnabled() {
        return maxFailAttempts() > 0;
    }

    private int maxFailAttempts() {
        return properties.getCaptcha().getMaxFailAttempts();
    }

    private long failWindowMs() {
        return Math.max(1, properties.getCaptcha().getFailWindowMinutes()) * 60_000L;
    }

    private int lockMinutes() {
        return properties.getCaptcha().getLockMinutes();
    }

    private int maxLockMinutes() {
        return properties.getCaptcha().getMaxLockMinutes();
    }

    private long tokenTtlMs() {
        return Math.max(1, properties.getCaptcha().getTokenTtlSeconds()) * 1_000L;
    }
}
