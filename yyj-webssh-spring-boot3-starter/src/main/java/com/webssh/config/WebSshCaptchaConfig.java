package com.webssh.config;

import cloud.tianai.captcha.common.constant.CaptchaTypeConstant;
import cloud.tianai.captcha.resource.CrudResourceStore;
import cloud.tianai.captcha.resource.ResourceStore;
import cloud.tianai.captcha.resource.common.model.dto.Resource;
import cloud.tianai.captcha.spring.autoconfiguration.CacheStoreAutoConfiguration;
import cloud.tianai.captcha.spring.autoconfiguration.ImageCaptchaAutoConfiguration;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.AutoConfigureAfter;
import org.springframework.boot.autoconfigure.AutoConfigureBefore;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.util.ArrayList;

import java.util.List;

/**
 * tianai-captcha 背景图资源配置
 *
 * <p>本 Starter 不依赖 redis，tianai-captcha-springboot-starter 在未引入 StringRedisTemplate 时
 * 会自动注册 LocalMemoryResourceStore（见 CacheStoreAutoConfiguration.LocalCacheStoreConfiguration），
 * 并在 ImageCaptchaAutoConfiguration 中根据 init-default-resource=true 加载系统默认滑块模板与字体。
 *
 * <p>此处不覆盖 resourceStore Bean（避免与 tianai 自动配置的 @ConditionalOnMissingBean 冲突），
 * 而是注入已注册的 ResourceStore，在 ImageCaptchaApplication 创建前向其追加自定义滑块背景图。
 *
 * <p>通过 @AutoConfigureAfter 确保在 CacheStoreAutoConfiguration 之后（ResourceStore 已存在），
 * 通过 @AutoConfigureBefore 确保在 ImageCaptchaAutoConfiguration 之前（背景图先于验证码应用就绪）。
 *
 * <p>背景图尺寸要求 600×360 像素，位于 classpath:captcha/bg/ 目录下，自动加载该目录下所有 png 图片。
 *
 * @author webssh
 */
@Configuration
@AutoConfigureAfter(CacheStoreAutoConfiguration.class)
@AutoConfigureBefore(ImageCaptchaAutoConfiguration.class)
public class WebSshCaptchaConfig {

    private static final Logger log = LoggerFactory.getLogger(WebSshCaptchaConfig.class);

    private static final String BG_DIR = "captcha/bg/";

    @Autowired
    private ResourceStore resourceStore;

    @PostConstruct
    public void addSliderBackgroundImages() {
        if (!(resourceStore instanceof CrudResourceStore)) {
            return;
        }
        CrudResourceStore crud = (CrudResourceStore) resourceStore;
        List<Resource> images = getSliderBackgroundImages();
        for (Resource bg : images) {
            crud.addResource(CaptchaTypeConstant.SLIDER, bg);
        }
        log.info("WebSSH: 已加载 {} 张滑块验证码背景图", images.size());
    }

    /**
     * 扫描 classpath:captcha/bg/ 目录下所有 png 图片，按文件名排序后返回
     */
    private List<Resource> getSliderBackgroundImages() {
        List<Resource> list = new ArrayList<>();
        try {
            PathMatchingResourcePatternResolver resolver = new PathMatchingResourcePatternResolver();
            org.springframework.core.io.Resource[] resources = resolver.getResources("classpath*:" + BG_DIR + "*.png");
            List<String> filenames = new ArrayList<>();
            for (org.springframework.core.io.Resource r : resources) {
                String name = r.getFilename();
                if (name != null && name.endsWith(".png")) {
                    filenames.add(name);
                }
            }
            filenames.sort(String::compareTo);
            for (String filename : filenames) {
                list.add(new Resource("classpath", BG_DIR + filename));
            }
        } catch (Exception e) {
            log.warn("WebSSH: 加载滑块验证码背景图失败: {}", e.getMessage());
        }
        return list;
    }
}
