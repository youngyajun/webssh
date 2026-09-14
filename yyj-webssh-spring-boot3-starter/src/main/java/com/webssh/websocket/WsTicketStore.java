package com.webssh.websocket;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * WebSocket 一次性连接票据存储
 * <p>用于替代“把 RSA 加密后的 SSH 密码直接放在 WebSocket URL 查询串”的做法：
 * 前端先用密文向 {@code /auth/ws-ticket} 换取一个短期、一次性的随机票据，
 * 握手时 URL 只携带该票据，服务端消费票据取回密码。这样即使 URL 被日志、
 * 反向代理或 Referer 记录，也不会泄露任何密码密文。</p>
 *
 * <p>票据特性：</p>
 * <ul>
 *   <li>随机：{@link SecureRandom} 生成的 256 位随机串（URL-safe Base64）；</li>
 *   <li>一次性：{@link #consume(String)} 取出即删除；</li>
 *   <li>短期：默认 60 秒过期，签发时机会性清理过期票据。</li>
 * </ul>
 *
 * @author webssh
 */
public class WsTicketStore {

    /** 票据有效期（毫秒）：握手应在签发后立即发生，60 秒足够覆盖网络抖动 */
    private static final long TICKET_TTL_MILLIS = 60_000L;

    /** 票据 -> 凭据信息 */
    private final Map<String, Ticket> tickets = new ConcurrentHashMap<>();

    private final SecureRandom random = new SecureRandom();

    /** 单张票据承载的连接凭据 */
    private static final class Ticket {
        final String password;
        final long expireAt;

        Ticket(String password, long expireAt) {
            this.password = password;
            this.expireAt = expireAt;
        }
    }

    /**
     * 签发一张一次性票据。
     *
     * @param password 已解密的 SSH 密码（可为 null，表示主机使用配置文件凭据）
     * @return 随机票据 ID
     */
    public String issue(String password) {
        purgeExpired();
        byte[] buf = new byte[32];
        random.nextBytes(buf);
        String id = Base64.getUrlEncoder().withoutPadding().encodeToString(buf);
        tickets.put(id, new Ticket(password, System.currentTimeMillis() + TICKET_TTL_MILLIS));
        return id;
    }

    /**
     * 一次性消费票据：返回其承载的密码并立即删除票据。
     *
     * @param ticketId 票据 ID
     * @return 密码；票据不存在或已过期时返回特殊标记，调用方据此判断票据是否有效
     */
    public ConsumeResult consume(String ticketId) {
        if (ticketId == null || ticketId.isEmpty()) {
            return ConsumeResult.INVALID;
        }
        Ticket t = tickets.remove(ticketId);
        if (t == null) {
            return ConsumeResult.INVALID;
        }
        if (t.expireAt < System.currentTimeMillis()) {
            return ConsumeResult.INVALID;
        }
        return new ConsumeResult(true, t.password);
    }

    /** 当前存储的票据数量（用于监控/测试） */
    public int size() {
        return tickets.size();
    }

    private void purgeExpired() {
        long now = System.currentTimeMillis();
        tickets.entrySet().removeIf(e -> e.getValue().expireAt < now);
    }

    /**
     * 票据消费结果：区分“票据无效”与“票据有效但密码为 null（主机用配置凭据）”。
     */
    public static final class ConsumeResult {
        /** 无效票据单例（不存在/已过期/已消费） */
        public static final ConsumeResult INVALID = new ConsumeResult(false, null);

        private final boolean valid;
        private final String password;

        ConsumeResult(boolean valid, String password) {
            this.valid = valid;
            this.password = password;
        }

        public boolean isValid() {
            return valid;
        }

        public String getPassword() {
            return password;
        }
    }
}
