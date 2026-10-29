package com.webssh.ssh;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * ZMODEM 活动门控
 * <p>用于区分“WebSocket 二进制帧是合法的 ZMODEM 协议字节”还是“借二进制帧绕过高风险命令拦截的攻击输入”。</p>
 *
 * <p>判定依据：ZMODEM 传输总是由<b>服务端输出</b>先发起——远端 rz/sz 进程通过 SSH/PTY 输出
 * ZMODEM 帧头，前端 zmodem sentry 检测到后才会触发 {@code sender} 回调以二进制帧回送协议字节。
 * 因此本类在 {@link #onOutput} 中扫描服务端输出流的 ZMODEM 帧头，一旦出现即标记该会话
 * “ZMODEM 活跃”；此后一段时间窗口内的二进制输入才允许原样透传。</p>
 *
 * <p>若在没有 ZMODEM 活跃标记时收到二进制帧（例如攻击者直接构造 {@code rm -rf /\r} 的二进制帧），
 * 调用方应将其按普通命令输入处理并经过高风险命令拦截，从而堵住绕过路径。</p>
 *
 * <p>本类为纯内存、servlet-free 的会话级状态跟踪器，线程安全：每个 WebSocket 会话的输出读取
 * 由单一线程驱动（{@code sendHandle}），{@code carry} 仅由该线程读写；{@code active}/{@code lastActivity}
 * 为 volatile，供输入线程（{@code recvHandleBinary}）跨线程读取。</p>
 *
 * @author webssh
 */
public class ZmodemGuard {

    /** ZMODEM 活跃状态的保活窗口（毫秒）：传输期间收发都会刷新，结束后超时自动失效 */
    private static final long ACTIVE_TTL_MILLIS = 30_000L;

    /** 跨块检测保留的尾部字节数（足够容纳被切分的帧头及其后的若干 hex 字符） */
    private static final int CARRY_BYTES = 8;

    /** ZMODEM 帧头字节：ZPAD(0x2A '*')、ZDLE(0x18)、ZBIN(0x42 'B') */
    private static final byte ZPAD = 0x2A;
    private static final byte ZDLE = 0x18;
    private static final byte ZBIN = 0x42;

    /** 会话 ID -> ZMODEM 状态 */
    private final Map<String, State> states = new ConcurrentHashMap<>();

    private static final class State {
        volatile boolean active;
        volatile long lastActivity;
        /** 上一输出块的尾部字节，用于跨块拼接检测被切分的帧头（仅输出线程访问） */
        byte[] carry = new byte[0];
    }

    /**
     * 处理发往客户端的一段服务端输出字节，检测其中是否含 ZMODEM 帧头。
     * 命中即标记该会话 ZMODEM 活跃；活跃期间每次输出都会刷新保活时间戳。
     *
     * @param sessionId WebSocket 会话 ID
     * @param data      输出字节缓冲
     * @param len       有效字节数（data 的前 len 个字节）
     */
    public void onOutput(String sessionId, byte[] data, int len) {
        if (sessionId == null || data == null || len <= 0) {
            return;
        }
        State st = states.computeIfAbsent(sessionId, k -> new State());
        if (!st.active) {
            if (indexOfMarker(data, len) >= 0) {
                st.active = true;
            } else if (st.carry.length > 0) {
                // 帧头可能跨块：用 上一块尾部 + 本块头部 拼接后再检测一次
                int head = Math.min(len, 12);
                byte[] joined = new byte[st.carry.length + head];
                System.arraycopy(st.carry, 0, joined, 0, st.carry.length);
                System.arraycopy(data, 0, joined, st.carry.length, head);
                if (indexOfMarker(joined, joined.length) >= 0) {
                    st.active = true;
                }
            }
        }
        if (st.active) {
            st.lastActivity = System.currentTimeMillis();
        }
        // 更新 carry 为本块尾部
        int carryLen = Math.min(len, CARRY_BYTES);
        byte[] carry = new byte[carryLen];
        System.arraycopy(data, len - carryLen, carry, 0, carryLen);
        st.carry = carry;
    }

    /**
     * 会话当前是否处于 ZMODEM 活跃窗口内（决定二进制输入是否可原样透传）。
     *
     * @param sessionId WebSocket 会话 ID
     * @return 活跃且未超时返回 true
     */
    public boolean isZmodemActive(String sessionId) {
        if (sessionId == null) {
            return false;
        }
        State st = states.get(sessionId);
        if (st == null || !st.active) {
            return false;
        }
        if (System.currentTimeMillis() - st.lastActivity > ACTIVE_TTL_MILLIS) {
            st.active = false;
            return false;
        }
        return true;
    }

    /**
     * 收到合法的 ZMODEM 二进制输入时刷新保活时间戳，避免长传输途中窗口意外失效。
     *
     * @param sessionId WebSocket 会话 ID
     */
    public void onBinaryInput(String sessionId) {
        if (sessionId == null) {
            return;
        }
        State st = states.get(sessionId);
        if (st != null && st.active) {
            st.lastActivity = System.currentTimeMillis();
        }
    }

    /**
     * 会话关闭时清理状态，避免内存泄漏。
     *
     * @param sessionId WebSocket 会话 ID
     */
    public void clear(String sessionId) {
        if (sessionId != null) {
            states.remove(sessionId);
        }
    }

    /**
     * 在字节缓冲中查找 ZMODEM 帧头，返回首个命中位置，未命中返回 -1。
     * 识别两种帧头（与前端 zmodem sentry 的检测保持一致）：
     * <ul>
     *   <li>二进制帧头：{@code 2A 2A 18 42}（"**\x18B"）；</li>
     *   <li>hex 帧头：{@code 2A 42}（"*B"）后紧跟至少 4 个 hex 字符。</li>
     * </ul>
     */
    private int indexOfMarker(byte[] b, int len) {
        for (int i = 0; i + 1 < len; i++) {
            if (b[i] != ZPAD) {
                continue;
            }
            // 二进制帧头 **\x18B
            if (i + 3 < len && b[i + 1] == ZPAD && b[i + 2] == ZDLE && b[i + 3] == ZBIN) {
                return i;
            }
            // hex 帧头 *B + 4 hex
            if (b[i + 1] == ZBIN && i + 5 < len
                    && isHex(b[i + 2]) && isHex(b[i + 3]) && isHex(b[i + 4]) && isHex(b[i + 5])) {
                return i;
            }
        }
        return -1;
    }

    private boolean isHex(byte v) {
        return (v >= '0' && v <= '9') || (v >= 'a' && v <= 'f') || (v >= 'A' && v <= 'F');
    }
}
