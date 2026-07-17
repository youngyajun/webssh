package com.webssh.websocket;

import com.webssh.ssh.LocalPtyService;
import com.webssh.ssh.SshService;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * WebSSH WebSocket 处理器
 * 负责终端交互的 WebSocket 连接处理
 * 支持文本帧（键盘输入）和二进制帧（ZMODEM rz/sz 文件传输）混合传输：
 * - 终端输出统一以 BinaryMessage 发送，前端通过 zmodem sentry 分流到终端或文件传输
 * - 前端键盘输入仍走 TextMessage（保留高风险命令拦截能力）
 * - ZMODEM 上传数据走 BinaryMessage（字节透传，跳过命令拦截）
 *
 * 主机类型分支：
 * - type=remote（默认）：走 {@link SshService}（JSch SSH 协议）
 * - type=local：走 {@link LocalPtyService}（本地 PTY，绕过 SSH）
 *
 * @author webssh
 */
public class WebSshWebSocketHandler extends AbstractWebSocketHandler {
    private static final Logger log = LoggerFactory.getLogger(WebSshWebSocketHandler.class);

    @Autowired
    private SshService sshService;

    @Autowired
    private LocalPtyService localPtyService;

    /** WebSocket 握手属性 key：标记本会话是否为本地 PTY 模式 */
    private static final String ATTR_LOCAL_PTY = "isLocalPty";

    private final ExecutorService executorService = Executors.newCachedThreadPool();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        log.info("WebSSH: WebSocket连接建立 {}", session.getId());

        String hostName = (String) session.getAttributes().get("host");
        if (hostName == null || hostName.isEmpty()) {
            session.sendMessage(new TextMessage("\r\n错误: 未指定连接主机\r\n"));
            session.close();
            return;
        }

        boolean isLocal = localPtyService.isLocalHost(hostName);
        session.getAttributes().put(ATTR_LOCAL_PTY, isLocal);

        try {
            if (isLocal) {
                localPtyService.initConnection(session, hostName);
            } else {
                sshService.initConnection(session, hostName);
            }

            executorService.submit(() -> {
                try {
                    if (isLocal) {
                        localPtyService.sendHandle(session);
                    } else {
                        sshService.sendHandle(session);
                    }
                } catch (Exception e) {
                    if (session.isOpen()) {
                        try {
                            session.sendMessage(new TextMessage("\r\n\r\n--- 连接已断开 ---\r\n"));
                        } catch (Exception ignored) {
                        }
                    }
                    log.error("WebSSH: 读取输出异常", e);
                }
            });
        } catch (Exception e) {
            log.error("WebSSH: 建立连接失败 (isLocal={})", isLocal, e);
            session.sendMessage(new TextMessage("\r\n连接失败: " + e.getMessage() + "\r\n"));
            session.close();
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        try {
            if (isLocalPty(session)) {
                localPtyService.recvHandle(session, message.getPayload());
            } else {
                sshService.recvHandle(session, message.getPayload());
            }
        } catch (Exception e) {
            log.error("WebSSH: 处理文本输入异常", e);
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) throws Exception {
        try {
            java.nio.ByteBuffer buf = message.getPayload();
            byte[] data = new byte[buf.remaining()];
            buf.get(data);
            if (isLocalPty(session)) {
                localPtyService.recvHandleBinary(session, data);
            } else {
                sshService.recvHandleBinary(session, data);
            }
        } catch (Exception e) {
            log.error("WebSSH: 处理二进制输入异常", e);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        log.info("WebSSH: WebSocket连接关闭 {} status={}", session.getId(), status);
        if (isLocalPty(session)) {
            localPtyService.closeConnection(session);
        } else {
            sshService.closeConnection(session);
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) throws Exception {
        log.error("WebSSH: WebSocket传输异常", exception);
        if (session.isOpen()) {
            session.close();
        }
        if (isLocalPty(session)) {
            localPtyService.closeConnection(session);
        } else {
            sshService.closeConnection(session);
        }
    }

    /**
     * 判断 WebSocket 会话是否为本地 PTY 模式
     * 依据 afterConnectionEstablished 时缓存的握手属性
     */
    private boolean isLocalPty(WebSocketSession session) {
        Object attr = session.getAttributes().get(ATTR_LOCAL_PTY);
        return Boolean.TRUE.equals(attr);
    }

    /**
     * 应用关闭时关闭线程池，避免线程泄漏
     * newCachedThreadPool 无上限，未关闭会导致应用关停时线程残留
     */
    @PreDestroy
    public void destroy() {
        log.info("WebSSH: 关闭 executorService");
        executorService.shutdownNow();
        try {
            if (!executorService.awaitTermination(5, TimeUnit.SECONDS)) {
                log.warn("WebSSH: executorService 未在 5s 内终止");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
