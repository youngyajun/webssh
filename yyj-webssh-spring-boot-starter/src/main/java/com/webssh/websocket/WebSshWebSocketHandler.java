package com.webssh.websocket;

import com.webssh.ssh.SshService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * WebSSH WebSocket 处理器
 * 负责终端交互的 WebSocket 连接处理
 *
 * @author webssh
 */
public class WebSshWebSocketHandler extends TextWebSocketHandler {
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
            sshService.recvHandle(session, message.getPayload());
        } catch (Exception e) {
            log.error("WebSSH: 处理输入异常", e);
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
}
