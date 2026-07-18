package com.webssh.config;

import com.webssh.controller.WebSshAuthController;
import com.webssh.controller.WebSshFileController;
import com.webssh.controller.WebSshPageController;
import com.webssh.security.ClientIpExtractor;
import com.webssh.security.LoginAttemptService;
import com.webssh.security.WebSshAuthInterceptor;
import com.webssh.ssh.LocalPtyService;
import com.webssh.ssh.SshConnectionFactory;
import com.webssh.ssh.SshService;
import com.webssh.ssh.SshSessionHolder;
import com.webssh.websocket.WebSshWebSocketConfig;
import com.webssh.websocket.WebSshWebSocketHandler;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * WebSSH 自动配置类
 * 引入该 Starter 后自动装配所有组件
 *
 * @author webssh
 */
@Configuration
@EnableConfigurationProperties(WebSshProperties.class)
@ConditionalOnProperty(prefix = "webssh", name = "enabled", havingValue = "true", matchIfMissing = true)
@Import({
        WebSshAuthController.class,
        WebSshPageController.class,
        WebSshFileController.class,
        LocalPtyService.class,
        LoginAttemptService.class,
        ClientIpExtractor.class,
        WebSshWebSocketConfig.class
})
public class WebSshAutoConfiguration {
    private static final Logger log = LoggerFactory.getLogger(WebSshAutoConfiguration.class);

    @org.springframework.beans.factory.annotation.Autowired
    private WebSshProperties properties;

    public WebSshAutoConfiguration() {
        log.info("WebSSH Starter 已自动装配");
    }

    /**
     * SSH 连接工厂
     */
    @Bean
    public SshConnectionFactory sshConnectionFactory(WebSshProperties properties) {
        return new SshConnectionFactory(properties);
    }

    /**
     * SSH 会话持有器
     */
    @Bean
    public SshSessionHolder sshSessionHolder() {
        return new SshSessionHolder();
    }

    /**
     * SSH 服务
     */
    @Bean
    public SshService sshService() {
        return new SshService();
    }

    /**
     * WebSocket 处理器
     */
    @Bean
    public WebSshWebSocketHandler webSshWebSocketHandler() {
        return new WebSshWebSocketHandler();
    }

    /**
     * 静态资源映射 + 认证拦截器注册
     * 将 contextPath 下的静态资源请求映射到 META-INF/resources/webssh/ 目录
     * 同时拦截需要登录才能访问的路径（API、index.html 等），未登录返回 401 或重定向到登录页
     */
    @Bean
    public WebMvcConfigurer webSshResourceConfigurer(WebSshProperties properties) {
        return new WebMvcConfigurer() {
            @Override
            public void addResourceHandlers(ResourceHandlerRegistry registry) {
                String contextPath = properties.getContextPath();
                if (!contextPath.endsWith("/")) {
                    contextPath = contextPath + "/";
                }
                registry.addResourceHandler(contextPath + "**")
                        .addResourceLocations("classpath:/META-INF/resources/webssh/");
            }

            @Override
            public void addInterceptors(InterceptorRegistry registry) {
                String contextPath = properties.getContextPath();
                if (!contextPath.endsWith("/")) {
                    contextPath = contextPath + "/";
                }
                // 拦截所有 contextPath 下的请求，排除登录页、auth 接口和静态资源
                registry.addInterceptor(new WebSshAuthInterceptor(properties))
                        .addPathPatterns(contextPath + "**")
                        .excludePathPatterns(
                                contextPath + "login.html",
                                contextPath + "auth/**",
                                contextPath + "images/**",
                                contextPath + "js/**",
                                contextPath + "style/**"
                        );
            }
        };
    }

    /**
     * 启动时校验管理凭据已配置
     * 支持两种配置方式（可共存，用户名冲突时以多账号为准）：
     *   1. 多账号模式：webssh.accounts 列表，每项含 username/password
     *   2. 单账号模式（向后兼容）：webssh.username + webssh.password
     * 两者均未配置或全部无效时仅告警，不阻止启动（登录将全部失败）
     *
     * 密码强度规则：长度 8~19 位（>=8 且 <20），必须同时包含大写字母、小写字母和数字
     * 不符合规则的账号视为无效，仅记录告警日志并跳过，不影响启动；
     * 登录认证只使用通过校验的有效账号（见 WebSshProperties.getValidAccounts()）
     */
    @PostConstruct
    public void validateCredentials() {
        List<WebSshProperties.Account> effective = properties.getEffectiveAccounts();

        if (effective.isEmpty()) {
            // 未配置任何账号：不阻止启动，但明确告警当前无人可登录
            log.error("WebSSH: 未配置任何管理账号，当前无可用账号，登录将全部失败！");
            log.error("WebSSH: 请在 application.yml 中设置 webssh.accounts（多账号），或 webssh.username/webssh.password（单账号）");
            return;
        }

        // 逐个校验账号：无效账号仅告警并跳过，不影响启动
        Set<String> seen = new HashSet<>();
        int validCount = 0;
        for (WebSshProperties.Account account : effective) {
            String name = (account != null && account.getUsername() != null && !account.getUsername().isEmpty()) ? account.getUsername() : "(未命名)";

            // 1. 字段与密码强度校验
            String reason = WebSshProperties.accountInvalidReason(account);
            if (reason != null) {
                log.warn("WebSSH: 账号 [{}] 配置无效已跳过（{}），该账号无法用于登录", name, reason);
                continue;
            }
            // 2. 重复用户名校验（仅保留首个）
            if (!seen.add(account.getUsername())) {
                log.warn("WebSSH: 账号 [{}] 用户名重复已跳过（仅保留首个同名账号）", name);
                continue;
            }
            validCount++;
        }
        if (validCount == 0) {
            // 所有账号均无效：不阻止启动，但明确告警当前无人可登录
            log.error("WebSSH: 所有管理账号均无效（密码不符合强度规则或字段缺失），当前无可用账号，登录将全部失败！");
            log.error("WebSSH: 密码强度规则——长度 8~19 位，必须同时包含大写字母、小写字母和数字");
        } else {
            log.info("WebSSH: 管理账号加载完成，有效账号 {} 个，无效账号 {} 个", validCount, effective.size() - validCount);
        }
    }
}
