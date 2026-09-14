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
     * SSH 主机密钥严格校验（对应 JSch 的 StrictHostKeyChecking）。默认开启，避免凭据和终端数据遭受中间人攻击。
     * 设为 false 时不校验主机密钥，存在中间人攻击风险，仅建议内网/测试环境使用。
     */
    private boolean strictHostKeyChecking = true;

    /**
     * known_hosts 文件路径（当 strict-host-key-checking=true 时使用）
     * 默认使用用户目录下的 ~/.ssh/known_hosts
     */
    private String knownHosts;

    /**
     * 允许发起 WebSocket 握手的浏览器 Origin 白名单。
     * 必须由部署者显式配置，不能使用通配符。
     */
    private List<String> allowedOrigins = new ArrayList<>();

    /** WebSocket 空闲超时（毫秒），默认 30 分钟。 */
    private long webSocketIdleTimeoutMillis = 30 * 60 * 1000L;

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

    /**
     * 旋转验证码配置（tianai-captcha）
     */
    private Captcha captcha = new Captcha();

    /**
     * 安全加固配置（安全响应头/CSP、自定义主机白名单、RSA 防 DoS 等）
     */
    private Security security = new Security();

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

    public boolean isStrictHostKeyChecking() {
        return strictHostKeyChecking;
    }

    public void setStrictHostKeyChecking(boolean strictHostKeyChecking) {
        this.strictHostKeyChecking = strictHostKeyChecking;
    }

    public String getKnownHosts() {
        return knownHosts;
    }

    public void setKnownHosts(String knownHosts) {
        this.knownHosts = knownHosts;
    }

    public List<String> getAllowedOrigins() {
        return allowedOrigins;
    }

    public void setAllowedOrigins(List<String> allowedOrigins) {
        this.allowedOrigins = allowedOrigins == null ? new ArrayList<>() : new ArrayList<>(allowedOrigins);
    }

    public long getWebSocketIdleTimeoutMillis() {
        return webSocketIdleTimeoutMillis;
    }

    public void setWebSocketIdleTimeoutMillis(long webSocketIdleTimeoutMillis) {
        this.webSocketIdleTimeoutMillis = webSocketIdleTimeoutMillis;
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

    public Captcha getCaptcha() {
        return captcha;
    }

    public void setCaptcha(Captcha captcha) {
        this.captcha = captcha;
    }

    public Security getSecurity() {
        return security;
    }

    public void setSecurity(Security security) {
        this.security = security;
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

    /**
     * 旋转验证码配置（tianai-captcha）
     * 不依赖 redis，验证码数据使用本地内存缓存；二次验证开启后，登录时需携带验证成功返回的 token
     */
    public static class Captcha {
        /**
         * 是否启用旋转验证码，默认 true
         * 设为 false 则登录时不校验验证码，前端也不弹出验证码
         */
        private boolean enabled = true;

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }
    }

    /**
     * 安全加固配置
     * <p>默认值在“安全”和“开箱即用（含 HTTP 部署）”之间取平衡：
     * 安全响应头与 CSP 默认开启，但不强制 HTTPS（HSTS 默认关闭），
     * 以便必须走 HTTP 的站点仍可正常使用；如需更强隔离可自行调整。</p>
     */
    public static class Security {
        /**
         * 是否启用安全响应头过滤器（X-Content-Type-Options / X-Frame-Options / Referrer-Policy 等）。
         * 默认 true。
         */
        private boolean headersEnabled = true;

        /**
         * Content-Security-Policy 头内容。留空字符串则不下发 CSP。
         * 默认策略适配本项目前端：脚本全部外链（'self'，无内联/无 eval），
         * 样式存在内联 style=""（需 'unsafe-inline'），验证码图片可能为 data:/blob:，
         * 终端走 WebSocket（connect-src 需 ws:/wss:）。如前端引入新资源来源需同步调整。
         */
        private String contentSecurityPolicy =
                "default-src 'self'; "
                + "script-src 'self'; "
                + "style-src 'self' 'unsafe-inline'; "
                + "img-src 'self' data: blob:; "
                + "font-src 'self' data:; "
                + "connect-src 'self' ws: wss:; "
                + "object-src 'none'; "
                + "frame-ancestors 'self'; "
                + "base-uri 'self'; "
                + "form-action 'self'";

        /**
         * 是否下发 HSTS（Strict-Transport-Security）头。
         * 默认 false，以兼容必须走 HTTP 的部署；仅当整站强制 HTTPS 时才应开启。
         */
        private boolean hstsEnabled = false;

        /**
         * HSTS max-age（秒），默认一年。仅 hstsEnabled=true 时生效。
         */
        private long hstsMaxAge = 31536000L;

        /**
         * 是否允许连接“配置文件 hosts 列表之外”的自定义主机（host:port）。
         * 默认 true 以保持既有“自由输入 IP 连接”的行为；
         * 对安全敏感的部署可设为 false，此时仅允许连接 hosts 列表中已配置的主机，
         * 防止已认证用户把服务器当作跳板连接任意内网地址（SSRF）。
         */
        private boolean allowCustomHost = true;

        /**
         * 自定义主机白名单（精确 host 或 CIDR 网段，如 192.168.1.0/24）。
         * 仅在 allowCustomHost=true 时生效；非空时，自定义主机必须命中白名单才允许连接。
         * 留空表示不限制（任意自定义主机均可，等同既有行为）。
         */
        private List<String> allowedCustomHosts = new ArrayList<>();

        /**
         * 单个 HttpSession 内 RSA 私钥映射表的最大条目数。
         * 超出时清理最早的条目，防止未认证用户反复请求 /auth/public-key
         * 在 Session 中堆积私钥导致内存耗尽。默认 20。
         */
        private int rsaKeyMapMaxSize = 20;

        /**
         * 单个 IP 每分钟允许请求 /auth/public-key 的最大次数。
         * 每次请求都会生成 2048 位 RSA 密钥对（CPU 开销较大），限流防止 DoS。
         * 设为 0 或负数表示关闭限流。默认 30。
         */
        private int publicKeyMaxPerMinute = 30;

        public boolean isHeadersEnabled() {
            return headersEnabled;
        }

        public void setHeadersEnabled(boolean headersEnabled) {
            this.headersEnabled = headersEnabled;
        }

        public String getContentSecurityPolicy() {
            return contentSecurityPolicy;
        }

        public void setContentSecurityPolicy(String contentSecurityPolicy) {
            this.contentSecurityPolicy = contentSecurityPolicy;
        }

        public boolean isHstsEnabled() {
            return hstsEnabled;
        }

        public void setHstsEnabled(boolean hstsEnabled) {
            this.hstsEnabled = hstsEnabled;
        }

        public long getHstsMaxAge() {
            return hstsMaxAge;
        }

        public void setHstsMaxAge(long hstsMaxAge) {
            this.hstsMaxAge = hstsMaxAge;
        }

        public boolean isAllowCustomHost() {
            return allowCustomHost;
        }

        public void setAllowCustomHost(boolean allowCustomHost) {
            this.allowCustomHost = allowCustomHost;
        }

        public List<String> getAllowedCustomHosts() {
            return allowedCustomHosts;
        }

        public void setAllowedCustomHosts(List<String> allowedCustomHosts) {
            this.allowedCustomHosts = allowedCustomHosts == null ? new ArrayList<>() : new ArrayList<>(allowedCustomHosts);
        }

        public int getRsaKeyMapMaxSize() {
            return rsaKeyMapMaxSize;
        }

        public void setRsaKeyMapMaxSize(int rsaKeyMapMaxSize) {
            this.rsaKeyMapMaxSize = rsaKeyMapMaxSize;
        }

        public int getPublicKeyMaxPerMinute() {
            return publicKeyMaxPerMinute;
        }

        public void setPublicKeyMaxPerMinute(int publicKeyMaxPerMinute) {
            this.publicKeyMaxPerMinute = publicKeyMaxPerMinute;
        }
    }
}
