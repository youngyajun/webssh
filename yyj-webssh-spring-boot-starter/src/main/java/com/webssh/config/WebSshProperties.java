package com.webssh.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.List;

/**
 * WebSSH 配置属性
 *
 * @author webssh
 */
@ConfigurationProperties(prefix = "webssh")
public class WebSshProperties {
    /**
     * 是否启用 WebSSH
     */
    private boolean enabled = true;

    /**
     * 访问路径前缀
     */
    private String contextPath = "/webssh";

    /**
     * WebSSH 界面访问的账号（独立于Linux连接账号）
     * 无默认值，启动时强制要求配置，防止使用默认凭据部署到生产环境
     */
    private String username;

    /**
     * WebSSH 界面访问的密码（独立于Linux连接账号）
     * 无默认值，启动时强制要求配置，建议使用强密码
     */
    private String password;

    /**
     * SSH 连接超时时间（毫秒）
     */
    private int timeout = 5000;

    /**
     * 终端类型
     */
    private String terminalType = "xterm";

    /**
     * 默认编码
     */
    private String charset = "UTF-8";

    /**
     * SSH 主机密钥校验策略：yes（严格校验，需配合 knownHosts）、no（不校验，存在中间人攻击风险）
     * 默认 no 以兼容内网开发场景（避免 known_hosts 中旧记录导致连接失败），
     * 生产环境强烈建议设为 yes 并配置 knownHosts 以防中间人攻击
     */
    private String hostKeyVerification = "no";

    /**
     * known_hosts 文件路径（当 hostKeyVerification=yes 时使用）
     * 默认使用用户目录下的 ~/.ssh/known_hosts
     */
    private String knownHosts;

    /**
     * SSH 主机列表（可配置多个Linux服务器）
     */
    private List<Host> hosts = new ArrayList<>();

    /**
     * 高风险命令列表（正则表达式，命中则拒绝通过终端执行）
     */
    private List<String> highRiskCommands = new ArrayList<>();

    /**
     * 登录安全策略（防暴力破解）
     */
    private LoginSecurity loginSecurity = new LoginSecurity();

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getContextPath() {
        return contextPath;
    }

    public void setContextPath(String contextPath) {
        this.contextPath = contextPath;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getPassword() {
        return password;
    }

    public void setPassword(String password) {
        this.password = password;
    }

    public int getTimeout() {
        return timeout;
    }

    public void setTimeout(int timeout) {
        this.timeout = timeout;
    }

    public String getTerminalType() {
        return terminalType;
    }

    public void setTerminalType(String terminalType) {
        this.terminalType = terminalType;
    }

    public String getCharset() {
        return charset;
    }

    public void setCharset(String charset) {
        this.charset = charset;
    }

    public String getHostKeyVerification() {
        return hostKeyVerification;
    }

    public void setHostKeyVerification(String hostKeyVerification) {
        this.hostKeyVerification = hostKeyVerification;
    }

    public String getKnownHosts() {
        return knownHosts;
    }

    public void setKnownHosts(String knownHosts) {
        this.knownHosts = knownHosts;
    }

    public List<Host> getHosts() {
        return hosts;
    }

    public void setHosts(List<Host> hosts) {
        this.hosts = hosts;
    }

    public List<String> getHighRiskCommands() {
        return highRiskCommands;
    }

    public void setHighRiskCommands(List<String> highRiskCommands) {
        this.highRiskCommands = highRiskCommands;
    }

    public LoginSecurity getLoginSecurity() {
        return loginSecurity;
    }

    public void setLoginSecurity(LoginSecurity loginSecurity) {
        this.loginSecurity = loginSecurity;
    }

    /**
     * SSH 主机配置
     */
    public static class Host {
        /**
         * 主机名称（显示用）
         */
        private String name;

        /**
         * 主机IP
         */
        private String host;

        /**
         * SSH端口，默认22
         */
        private int port = 22;

        /**
         * 用户名
         */
        private String username;

        /**
         * 密码
         */
        private String password;

        /**
         * 私钥路径（可选，与密码二选一）
         */
        private String privateKey;

        /**
         * 私钥密码（可选）
         */
        private String passphrase;

        public String getName() {
            return name;
        }

        public void setName(String name) {
            this.name = name;
        }

        public String getHost() {
            return host;
        }

        public void setHost(String host) {
            this.host = host;
        }

        public int getPort() {
            return port;
        }

        public void setPort(int port) {
            this.port = port;
        }

        public String getUsername() {
            return username;
        }

        public void setUsername(String username) {
            this.username = username;
        }

        public String getPassword() {
            return password;
        }

        public void setPassword(String password) {
            this.password = password;
        }

        public String getPrivateKey() {
            return privateKey;
        }

        public void setPrivateKey(String privateKey) {
            this.privateKey = privateKey;
        }

        public String getPassphrase() {
            return passphrase;
        }

        public void setPassphrase(String passphrase) {
            this.passphrase = passphrase;
        }

        @Override
        public String toString() {
            return "Host{name='" + name + "', host='" + host + "', port=" + port + "}";
        }
    }

    /**
     * 登录安全策略（防暴力破解）
     * 基于 IP 统计登录失败次数，超过阈值后锁定一段时间
     */
    public static class LoginSecurity {
        /**
         * 允许的最大登录失败次数，超过则锁定 IP（设为 0 或负数表示关闭限制）
         */
        private int maxFailAttempts = 5;

        /**
         * 锁定时长（分钟）
         */
        private int lockMinutes = 5;

        /**
         * 是否信任 X-Forwarded-For 等代理转发头来识别客户端 IP
         * 默认 false，直接使用 request.getRemoteAddr()，防止攻击者伪造头绕过 IP 锁定
         * 仅在确信前端有受信反向代理且需要透传真实客户端 IP 时才设为 true
         */
        private boolean trustForwardedFor = false;

        public int getMaxFailAttempts() {
            return maxFailAttempts;
        }

        public void setMaxFailAttempts(int maxFailAttempts) {
            this.maxFailAttempts = maxFailAttempts;
        }

        public int getLockMinutes() {
            return lockMinutes;
        }

        public void setLockMinutes(int lockMinutes) {
            this.lockMinutes = lockMinutes;
        }

        public boolean isTrustForwardedFor() {
            return trustForwardedFor;
        }

        public void setTrustForwardedFor(boolean trustForwardedFor) {
            this.trustForwardedFor = trustForwardedFor;
        }
    }
}
