package com.webssh.ssh;

import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import com.webssh.config.WebSshProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Properties;

/**
 * SSH 连接工厂
 * 负责创建 JSch Session
 *
 * @author webssh
 */
public class SshConnectionFactory {
    private static final Logger log = LoggerFactory.getLogger(SshConnectionFactory.class);

    private final WebSshProperties properties;

    public SshConnectionFactory(WebSshProperties properties) {
        this.properties = properties;
    }

    /**
     * 创建 SSH Session
     */
    public Session createSession(WebSshProperties.Host host) throws Exception {
        return createSession(host, null, null);
    }

    /**
     * 创建 SSH Session
     *
     * @param host             主机配置（含 host/port/privateKey 等）
     * @param overrideUsername 外部传入的用户名（界面输入），为空则回退到配置
     * @param overridePassword 外部传入的密码（界面输入），为空则回退到配置
     */
    public Session createSession(WebSshProperties.Host host, String overrideUsername,
                                 String overridePassword) throws Exception {
        JSch jsch = new JSch();

        // 确定最终使用的用户名：外部传入优先，否则回退到配置
        String username = (overrideUsername != null && !overrideUsername.isEmpty())
                ? overrideUsername : host.getUsername();
        if (username == null || username.isEmpty()) {
            throw new IllegalArgumentException("SSH用户名不能为空，请在配置文件或界面中提供");
        }

        // 确定最终使用的密码：外部传入优先，否则回退到配置
        String password = (overridePassword != null && !overridePassword.isEmpty())
                ? overridePassword : host.getPassword();

        // 配置私钥认证
        if (host.getPrivateKey() != null && !host.getPrivateKey().isEmpty()) {
            if (host.getPassphrase() != null && !host.getPassphrase().isEmpty()) {
                jsch.addIdentity(host.getPrivateKey(), host.getPassphrase());
            } else {
                jsch.addIdentity(host.getPrivateKey());
            }
        }

        log.info("WebSSH: 正在连接 {}@{}:{}", username, host.getHost(), host.getPort());

        // 主机密钥校验策略：默认 no（兼容内网开发），用户可配置为 yes 开启严格校验
        String hostKeyVerification = properties.getHostKeyVerification();
        if (hostKeyVerification == null || hostKeyVerification.isEmpty()) {
            hostKeyVerification = "no";
        }

        // 仅在开启严格校验时才加载 known_hosts；
        // 关闭校验时不加载，避免 known_hosts 中旧记录与服务器当前密钥不匹配时抛 JSchChangedHostKeyException
        if ("yes".equalsIgnoreCase(hostKeyVerification)) {
            String knownHosts = properties.getKnownHosts();
            if (knownHosts == null || knownHosts.isEmpty()) {
                knownHosts = System.getProperty("user.home") + "/.ssh/known_hosts";
            }
            try {
                jsch.setKnownHosts(knownHosts);
                log.info("WebSSH: 已开启主机密钥严格校验，known_hosts={}", knownHosts);
            } catch (Exception e) {
                log.warn("WebSSH: 加载 known_hosts 失败: {}，主机密钥校验可能受限", knownHosts);
            }
        } else {
            log.warn("WebSSH: 主机密钥校验已关闭（StrictHostKeyChecking=no），存在中间人攻击风险");
        }

        // 创建 session
        Session session = jsch.getSession(username, host.getHost(), host.getPort());

        // 配置密码认证
        if (password != null && !password.isEmpty()) {
            session.setPassword(password);
        }

        // 配置 properties
        Properties config = new Properties();
        config.put("StrictHostKeyChecking", hostKeyVerification);
        config.put("PreferredAuthentications", "publickey,keyboard-interactive,password");
        session.setConfig(config);

        // 设置超时
        session.setTimeout(properties.getTimeout());
        session.connect();

        log.info("WebSSH: 连接成功 {}@{}:{}", username, host.getHost(), host.getPort());

        return session;
    }
}
