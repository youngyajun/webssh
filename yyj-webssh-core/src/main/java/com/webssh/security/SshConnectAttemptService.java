package com.webssh.security;

import com.webssh.config.WebSshProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * SSH 连接尝试限制服务
 * <p>基于 IP 统计 {@code /api/connect} 建立 SSH 会话时的认证失败次数，超过阈值后锁定一段时间。
 * 防止已认证用户把 webssh 服务器当作“SSH 爆破代理”对内网/任意主机批量试探口令。</p>
 *
 * <p>与保护 webssh 自身登录的 {@link LoginAttemptService} 相互独立：
 * 后者统计的是“登录 webssh 界面”的失败，本类统计的是“通过 webssh 连接目标 SSH 主机”的失败。</p>
 *
 * <p>本类位于 servlet-free 的 core 模块，客户端 IP 的提取由调用方（starter 的 ClientIpExtractor）负责。</p>
 *
 * @author webssh
 */
@Service
public class SshConnectAttemptService {
    private static final Logger log = LoggerFactory.getLogger(SshConnectAttemptService.class);

    @Autowired
    private WebSshProperties properties;

    /** 按 IP 维护 SSH 连接失败记录 */
    private final Map<String, AttemptInfo> attemptMap = new ConcurrentHashMap<>();

    /** 单个 IP 的 SSH 连接失败尝试记录 */
    private static class AttemptInfo {
        int failCount;
        long lockUntil;

        AttemptInfo() {
            this.failCount = 0;
            this.lockUntil = 0;
        }
    }

    /**
     * 检查指定 IP 的 SSH 连接是否已被锁定
     */
    public LoginAttemptService.LockStatus checkLocked(String ip) {
        if (!isEnabled() || ip == null) {
            return new LoginAttemptService.LockStatus(false, Integer.MAX_VALUE, 0);
        }
        AttemptInfo info = attemptMap.get(ip);
        if (info == null || info.lockUntil == 0) {
            int used = info == null ? 0 : info.failCount;
            int remaining = Math.max(0, maxFailAttempts() - used);
            return new LoginAttemptService.LockStatus(false, remaining, 0);
        }
        long now = System.currentTimeMillis();
        synchronized (info) {
            if (info.lockUntil > now) {
                long remaining = (info.lockUntil - now) / 1000;
                return new LoginAttemptService.LockStatus(true, 0, Math.max(1, remaining));
            }
        }
        // 锁定已过期，清除记录，重新开始计数
        attemptMap.remove(ip);
        return new LoginAttemptService.LockStatus(false, maxFailAttempts(), 0);
    }

    /**
     * 记录一次 SSH 连接认证失败，返回最新状态
     */
    public LoginAttemptService.LockStatus recordFailure(String ip) {
        if (!isEnabled() || ip == null) {
            return new LoginAttemptService.LockStatus(false, Integer.MAX_VALUE, 0);
        }
        AttemptInfo info = attemptMap.computeIfAbsent(ip, k -> new AttemptInfo());
        synchronized (info) {
            info.failCount++;
            if (info.failCount >= maxFailAttempts()) {
                info.lockUntil = System.currentTimeMillis() + lockDurationMs();
                log.warn("WebSSH: IP {} 的 SSH 连接认证失败次数达到上限（{}），已锁定 {} 分钟（防爆破代理）",
                        ip, info.failCount, lockMinutes());
            }
        }
        return checkLocked(ip);
    }

    /**
     * 记录一次 SSH 连接成功，清除该 IP 的失败记录
     */
    public void recordSuccess(String ip) {
        if (ip != null) {
            attemptMap.remove(ip);
        }
    }

    private boolean isEnabled() {
        return maxFailAttempts() > 0;
    }

    private int maxFailAttempts() {
        return properties.getConnectSecurity().getMaxFailAttempts();
    }

    private int lockMinutes() {
        return properties.getConnectSecurity().getLockMinutes();
    }

    private long lockDurationMs() {
        return lockMinutes() * 60_000L;
    }
}
