package com.webssh.ssh;

import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import com.webssh.config.WebSshProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
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

        // 主机密钥严格校验。关闭校验会让 SSH 凭据和会话暴露给中间人攻击，仅建议内网/测试环境使用。
        boolean strictHostKeyChecking = properties.isStrictHostKeyChecking();
        if (strictHostKeyChecking) {
            String knownHosts = properties.getKnownHosts();
            if (knownHosts == null || knownHosts.isEmpty()) {
                knownHosts = System.getProperty("user.home") + "/.ssh/known_hosts";
            }
            Path knownHostsPath = Paths.get(knownHosts);
            if (!Files.isRegularFile(knownHostsPath) || !Files.isReadable(knownHostsPath)) {
                throw new IllegalStateException("无法读取 SSH known_hosts 文件: " + knownHostsPath);
            }
            try {
                jsch.setKnownHosts(knownHostsPath.toString());
                log.info("WebSSH: 已开启主机密钥严格校验，known_hosts={}", knownHostsPath);
            } catch (Exception e) {
                throw new IllegalStateException("加载 SSH known_hosts 失败: " + knownHostsPath, e);
            }
        } else {
            log.warn("WebSSH: 主机密钥严格校验已关闭（webssh.strict-host-key-checking=false），连接存在中间人攻击风险，仅建议内网/测试环境使用");
        }

        // 创建 session
        Session session = jsch.getSession(username, host.getHost(), host.getPort());

        // 配置密码认证
        if (password != null && !password.isEmpty()) {
            session.setPassword(password);
        }

        // 配置 properties
        Properties config = new Properties();
        config.put("StrictHostKeyChecking", strictHostKeyChecking ? "yes" : "no");
        config.put("PreferredAuthentications", "publickey,keyboard-interactive,password");
        session.setConfig(config);

        // 设置超时
        session.setTimeout(properties.getTimeout());
        session.connect();

        log.info("WebSSH: 连接成功 {}@{}:{}", username, host.getHost(), host.getPort());

        return session;
    }
}
