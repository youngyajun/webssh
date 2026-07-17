package com.webssh.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

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
     * WebSSH 界面访问的账号（单账号模式，向后兼容）
     * 无默认值，启动时强制要求配置，防止使用默认凭据部署到生产环境
     * 与 accounts（多账号）共存：若用户名与 accounts 中已有账号冲突，则忽略单账号（以多账号为准）
     */
    private String username;

    /**
     * WebSSH 界面访问的密码（单账号模式，向后兼容）
     * 无默认值，启动时强制要求配置，建议使用强密码
     * 与 accounts（多账号）共存：若用户名与 accounts 中已有账号冲突，则忽略单账号（以多账号为准）
     */
    private String password;

    /**
     * WebSSH 管理界面多账号列表（多账号模式）
     * 与 username/password（单账号）共存，两者将合并为最终账号列表；
     * 用户名冲突时以多账号为准（单账号被跳过）
     */
    private List<Account> accounts = new ArrayList<>();

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

    public List<Account> getAccounts() {
        return accounts;
    }

    public void setAccounts(List<Account> accounts) {
        this.accounts = accounts;
    }

    /**
     * 获取生效的管理账号列表（统一入口，供启动校验与登录认证使用）
     * 单账号与多账号共存，按以下规则合并：
     *   1. 先加入 accounts（多账号）中所有用户名非空的账号
     *   2. 再加入 username/password（单账号）：若其用户名与 accounts 中任一账号冲突，则跳过（以多账号为准）
     *   3. 两者均未配置时返回空列表（调用方仅告警，不阻止启动）
     */
    public List<Account> getEffectiveAccounts() {
        List<Account> result = new ArrayList<>();
        Set<String> seenUsernames = new HashSet<>();

        // 1. 先收录多账号（冲突时以此为准）
        if (accounts != null) {
            for (Account account : accounts) {
                if (account == null || account.getUsername() == null || account.getUsername().isEmpty()) {
                    continue;
                }
                if (seenUsernames.add(account.getUsername())) {
                    result.add(account);
                }
            }
        }

        // 2. 再尝试追加单账号：用户名与多账号冲突时跳过（以多账号为准）
        if (username != null && !username.isEmpty() && password != null && !password.isEmpty()) {
            if (seenUsernames.add(username)) {
                Account single = new Account();
                single.setUsername(username);
                single.setPassword(password);
                result.add(single);
            }
        }

        return result;
    }

    /**
     * 获取通过校验的有效管理账号列表（供登录认证使用）
     * 过滤规则：
     *   1. username 非空
     *   2. password 符合强度规则（长度 8~19 位，含大写字母、小写字母、数字）
     *   3. 同名账号仅保留首个（后续视为无效跳过）
     * 不符合规则的账号被静默跳过，不影响启动
     */
    public List<Account> getValidAccounts() {
        List<Account> valid = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Account account : getEffectiveAccounts()) {
            if (!isAccountValid(account)) {
                continue;
            }
            if (!seen.add(account.getUsername())) {
                continue;
            }
            valid.add(account);
        }
        return valid;
    }

    /**
     * 账号是否有效（用户名非空且密码符合强度规则）
     */
    public static boolean isAccountValid(Account account) {
        return accountInvalidReason(account) == null;
    }

    /**
     * 密码是否符合强度规则
     * 规则：长度 8~19 位（>=8 且 <20），必须同时包含大写字母、小写字母和数字
     */
    public static boolean isPasswordStrong(String password) {
        return passwordInvalidReason(password) == null;
    }

    /**
     * 返回账号无效的具体原因；账号有效则返回 null
     * 供启动校验日志输出使用
     */
    public static String accountInvalidReason(Account account) {
        if (account == null) {
            return "账号为空";
        }
        if (account.getUsername() == null || account.getUsername().isEmpty()) {
            return "用户名为空";
        }
        return passwordInvalidReason(account.getPassword());
    }

    /**
     * 返回密码不符合强度规则的具体原因；符合则返回 null
     * 规则：长度 8~19 位（>=8 且 <20），必须同时包含大写字母、小写字母和数字
     */
    public static String passwordInvalidReason(String password) {
        if (password == null || password.isEmpty()) {
            return "密码为空";
        }
        if (password.length() < 8) {
            return "密码长度不足8位";
        }
        if (password.length() >= 20) {
            return "密码长度需小于20位";
        }
        boolean hasUpper = false;
        boolean hasLower = false;
        boolean hasDigit = false;
        for (int i = 0; i < password.length(); i++) {
            char c = password.charAt(i);
            if (Character.isUpperCase(c)) {
                hasUpper = true;
            } else if (Character.isLowerCase(c)) {
                hasLower = true;
            } else if (Character.isDigit(c)) {
                hasDigit = true;
            }
        }
        if (!hasUpper) {
            return "密码缺少大写字母";
        }
        if (!hasLower) {
            return "密码缺少小写字母";
        }
        if (!hasDigit) {
            return "密码缺少数字";
        }
        return null;
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
     * WebSSH 管理界面账号（独立于 Linux 连接账号）
     */
    public static class Account {
        /**
         * 登录用户名
         */
        private String username;

        /**
         * 登录密码（建议使用强密码）
         */
        private String password;

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

        @Override
        public String toString() {
            return "Account{username='" + username + "'}";
        }
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

        /**
         * 连接类型：
         *   - "remote"（默认）：通过 SSH 协议连接到 host:port（需要凭据）
         *   - "local"：直接在本机启动 PTY shell（用于 webssh 与目标机同机部署的场景，
         *     无需 SSH 凭据；仅 Linux/Mac 等类 Unix 系统支持）
         */
        private String type = "remote";

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

        public String getType() {
            return type;
        }

        public void setType(String type) {
            this.type = type;
        }

        /**
         * 是否为本地 PTY 模式
         */
        public boolean isLocal() {
            return "local".equalsIgnoreCase(type);
        }

        @Override
        public String toString() {
            return "Host{name='" + name + "', host='" + host + "', port=" + port
                    + ", type='" + type + "'}";
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
