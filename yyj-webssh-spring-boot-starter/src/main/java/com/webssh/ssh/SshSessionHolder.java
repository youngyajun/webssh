package com.webssh.ssh;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.Session;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * SSH 会话持有器
 * 管理每个 WebSocket 会话对应的 SSH 连接
 *
 * @author webssh
 */
public class SshSessionHolder {
    private static final Logger log = LoggerFactory.getLogger(SshSessionHolder.class);

    /**
     * sessionId -> SSH Session
     */
    private final Map<String, Session> sessionMap = new ConcurrentHashMap<>();

    /**
     * sessionId -> ChannelShell
     */
    private final Map<String, Channel> channelMap = new ConcurrentHashMap<>();

    public void putSession(String sessionId, Session session) {
        sessionMap.put(sessionId, session);
    }

    public Session getSession(String sessionId) {
        return sessionMap.get(sessionId);
    }

    public void putChannel(String sessionId, Channel channel) {
        channelMap.put(sessionId, channel);
    }

    public Channel getChannel(String sessionId) {
        return channelMap.get(sessionId);
    }

    public void removeChannel(String sessionId) {
        channelMap.remove(sessionId);
    }

    /**
     * 获取或创建 SFTP Channel
     */
    public ChannelSftp getSftpChannel(String sessionId) throws Exception {
        Session session = sessionMap.get(sessionId);
        if (session == null) {
            throw new IllegalStateException("SSH会话不存在: " + sessionId);
        }
        ChannelSftp channel = (ChannelSftp) session.openChannel("sftp");
        channel.connect();
        return channel;
    }

    /**
     * 执行单条命令并返回结果
     */
    public String executeCommand(String sessionId, String command) throws Exception {
        Session session = sessionMap.get(sessionId);
        if (session == null) {
            throw new IllegalStateException("SSH会话不存在: " + sessionId);
        }

        ChannelExec channelExec = null;
        try {
            channelExec = (ChannelExec) session.openChannel("exec");
            channelExec.setCommand(command);
            channelExec.setInputStream(null);

            java.io.InputStream in = channelExec.getInputStream();
            channelExec.connect();

            String output = readStream(in);
            // 默认 PTY 模式下 stderr 会合并到 stdout，
            // 不单独调用 setErrStream(null) 避免 getErrStream() 返回 null 导致 NPE
            int exitCode = channelExec.getExitStatus();

            StringBuilder result = new StringBuilder();
            if (output != null && !output.isEmpty()) {
                result.append(output);
            }
            if (exitCode != 0) {
                result.append("\n[exit code: ").append(exitCode).append("]\n");
            }
            return result.toString();
        } finally {
            if (channelExec != null) {
                channelExec.disconnect();
            }
        }
    }

    private String readStream(java.io.InputStream in) throws Exception {
        java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int len;
        while ((len = in.read(buffer)) > 0) {
            baos.write(buffer, 0, len);
        }
        return baos.toString("UTF-8");
    }

    /**
     * 关闭并移除指定会话
     */
    public void closeSession(String sessionId) {
        Channel channel = channelMap.remove(sessionId);
        if (channel != null) {
            try {
                channel.disconnect();
            } catch (Exception e) {
                log.warn("关闭channel异常: {}", e.getMessage());
            }
        }

        Session session = sessionMap.remove(sessionId);
        if (session != null) {
            try {
                session.disconnect();
            } catch (Exception e) {
                log.warn("关闭session异常: {}", e.getMessage());
            }
        }
        log.info("WebSSH: 会话已关闭 {}", sessionId);
    }

    public boolean contains(String sessionId) {
        return sessionMap.containsKey(sessionId);
    }

    /**
     * 直接获取 JSch Session（用于需要直接操作底层 Channel 的场景，如目录下载）
     */
    public Session getJschSession(String sessionId) {
        return sessionMap.get(sessionId);
    }
}
