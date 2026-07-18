package com.webssh.security;

import com.webssh.config.WebSshProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 登录尝试限制服务
 * 基于 IP 统计登录失败次数，超过阈值后锁定一段时间，防止密码被暴力破解
 *
 * <p>多版本适配说明：
 * 本类位于 servlet-free 的 core 模块，不依赖 HttpServletRequest。
 * 客户端 IP 的提取（含 X-Forwarded-For 解析）由调用方（各版本 starter）负责，
 * 见 starter 的 ClientIpExtractor。</p>
 *
 * @author webssh
 */
@Service
public class LoginAttemptService {
    private static final Logger log = LoggerFactory.getLogger(LoginAttemptService.class);

    @Autowired
    private WebSshProperties properties;

    /** 按 IP 维护登录失败记录 */
    private final Map<String, AttemptInfo> attemptMap = new ConcurrentHashMap<>();

    /**
     * 单个 IP 的失败尝试记录
     */
    private static class AttemptInfo {
        int failCount;
        long lastFailTime;
        /** 锁定截止时间（毫秒时间戳），0 表示未锁定 */
        long lockUntil;

        AttemptInfo() {
            this.failCount = 0;
            this.lastFailTime = 0;
            this.lockUntil = 0;
        }
    }

    /**
     * 锁定状态
     */
    public static class LockStatus {
        private final boolean locked;
        private final int remainingAttempts;
        private final long lockRemainingSeconds;

        LockStatus(boolean locked, int remainingAttempts, long lockRemainingSeconds) {
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
     * 检查指定 IP 是否已被锁定
     */
    public LockStatus checkLocked(String ip) {
        if (!isEnabled()) {
            return new LockStatus(false, Integer.MAX_VALUE, 0);
        }
        AttemptInfo info = attemptMap.get(ip);
        if (info == null || info.lockUntil == 0) {
            int used = info == null ? 0 : info.failCount;
            int remaining = Math.max(0, maxFailAttempts() - used);
            return new LockStatus(false, remaining, 0);
        }
        long now = System.currentTimeMillis();
        if (info.lockUntil > now) {
            long remaining = (info.lockUntil - now) / 1000;
            return new LockStatus(true, 0, Math.max(1, remaining));
        }
        // 锁定已过期，清除记录，重新开始计数
        attemptMap.remove(ip);
        return new LockStatus(false, maxFailAttempts(), 0);
    }

    /**
     * 记录一次登录失败，返回最新状态
     */
    public LockStatus recordFailure(String ip) {
        if (!isEnabled()) {
            return new LockStatus(false, Integer.MAX_VALUE, 0);
        }
        AttemptInfo info = attemptMap.computeIfAbsent(ip, k -> new AttemptInfo());
        synchronized (info) {
            info.failCount++;
            info.lastFailTime = System.currentTimeMillis();
            if (info.failCount >= maxFailAttempts()) {
                info.lockUntil = info.lastFailTime + lockDurationMs();
                log.warn("IP {} 登录失败次数达到上限（{}），已锁定 {} 分钟", ip, info.failCount, lockMinutes());
            }
        }
        return checkLocked(ip);
    }

    /**
     * 记录登录成功，清除该 IP 的失败记录
     */
    public void recordSuccess(String ip) {
        attemptMap.remove(ip);
    }

    private boolean isEnabled() {
        return maxFailAttempts() > 0;
    }

    private int maxFailAttempts() {
        return properties.getLoginSecurity().getMaxFailAttempts();
    }

    private int lockMinutes() {
        return properties.getLoginSecurity().getLockMinutes();
    }

    private long lockDurationMs() {
        return lockMinutes() * 60_000L;
    }
}
