package com.webssh.websocket;

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
 * - SSH 输出统一以 BinaryMessage 发送，前端通过 zmodem sentry 分流到终端或文件传输
 * - 前端键盘输入仍走 TextMessage（保留高风险命令拦截能力）
 * - ZMODEM 上传数据走 BinaryMessage（字节透传，跳过命令拦截）
 *
 * @author webssh
 */
public class WebSshWebSocketHandler extends AbstractWebSocketHandler {
    private static final Logger log = LoggerFactory.getLogger(WebSshWebSocketHandler.class);

    @Autowired
    private SshService sshService;

    private final ExecutorService executorService = Executors.newCachedThreadPool();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        log.info("WebSSH: WebSocket连接建立 {}", session.getId());

        // 从握手属性中获取主机名
        String hostName = (String) session.getAttributes().get("host");
        if (hostName == null || hostName.isEmpty()) {
            session.sendMessage(new TextMessage("\r\n错误: 未指定连接主机\r\n"));
            session.close();
            return;
        }

        try {
            // 初始化 SSH 连接
            sshService.initConnection(session, hostName);

            // 启动后台线程读取 SSH 输出并回传给前端
            executorService.submit(() -> {
                try {
                    sshService.sendHandle(session);
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
            log.error("WebSSH: 建立SSH连接失败", e);
            session.sendMessage(new TextMessage("\r\n连接失败: " + e.getMessage() + "\r\n"));
            session.close();
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        try {
            // 文本输入：走原有的命令拦截 + 透传逻辑
            sshService.recvHandle(session, message.getPayload());
        } catch (Exception e) {
            log.error("WebSSH: 处理文本输入异常", e);
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) throws Exception {
        try {
            // 二进制输入：ZMODEM 上传数据（rz），字节透传到 SSH 通道，不做命令拦截
            // 通过 remaining() + get() 提取字节，兼容 heap/direct ByteBuffer 及非零 position 场景
            java.nio.ByteBuffer buf = message.getPayload();
            byte[] data = new byte[buf.remaining()];
            buf.get(data);
            sshService.recvHandleBinary(session, data);
        } catch (Exception e) {
            log.error("WebSSH: 处理二进制输入异常", e);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        log.info("WebSSH: WebSocket连接关闭 {} status={}", session.getId(), status);
        sshService.closeConnection(session);
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) throws Exception {
        log.error("WebSSH: WebSocket传输异常", exception);
        if (session.isOpen()) {
            session.close();
        }
        sshService.closeConnection(session);
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
