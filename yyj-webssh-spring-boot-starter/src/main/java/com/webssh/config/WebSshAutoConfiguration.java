package com.webssh.config;

import com.webssh.security.WebSshAuthInterceptor;
import com.webssh.ssh.SshConnectionFactory;
import com.webssh.ssh.SshService;
import com.webssh.ssh.SshSessionHolder;
import com.webssh.websocket.WebSshWebSocketHandler;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * WebSSH 自动配置类
 * 引入该 Starter 后自动装配所有组件
 *
 * @author webssh
 */
@Configuration
@EnableConfigurationProperties(WebSshProperties.class)
@ConditionalOnProperty(prefix = "webssh", name = "enabled", havingValue = "true", matchIfMissing = true)
@ComponentScan(basePackages = "com.webssh")
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
     * 移除默认凭据后强制用户显式配置 webssh.username 和 webssh.password，
     * 防止使用默认 admin/admin123 部署到生产环境
     */
    @PostConstruct
    public void validateCredentials() {
        if (properties.getUsername() == null || properties.getUsername().isEmpty()) {
            throw new IllegalStateException(
                    "WebSSH 启动失败：未配置管理账号，请在 application.yml 中设置 webssh.username");
        }
        if (properties.getPassword() == null || properties.getPassword().isEmpty()) {
            throw new IllegalStateException(
                    "WebSSH 启动失败：未配置管理密码，请在 application.yml 中设置 webssh.password"
                            + "（建议使用强密码）");
        }
        if ("admin123".equals(properties.getPassword()) || "admin".equals(properties.getUsername())) {
            log.warn("WebSSH: 检测到使用默认凭据 admin/admin123，存在严重安全风险，请立即修改！");
        }
    }
}
