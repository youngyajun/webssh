package com.webssh.controller;

import cloud.tianai.captcha.application.ImageCaptchaApplication;
import cloud.tianai.captcha.application.vo.ImageCaptchaVO;
import cloud.tianai.captcha.common.constant.CaptchaTypeConstant;
import cloud.tianai.captcha.common.response.ApiResponse;
import cloud.tianai.captcha.validator.common.model.dto.ImageCaptchaTrack;
import com.webssh.config.WebSshProperties;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * WebSSH 滑块验证码控制器（tianai-captcha）
 *
 * <p>提供验证码生成与校验接口，符合 tianai-captcha 默认接口规范：
 * <ul>
 *   <li>生成：POST /captcha/get，返回 {code:200, data:{}}</li>
 *   <li>校验：POST /captcha/check，返回 {code:200, data:{token:xxx}} / {code:500, msg:'xxx'}</li>
 * </ul>
 *
 * <p>校验成功后返回 token（即验证码 ID），前端登录时携带该 token 进行二次校验。
 *
 * @author webssh
 */
@RestController
@RequestMapping("${webssh.context-path:/webssh}/captcha")
public class WebSshCaptchaController {

    @Autowired
    private ImageCaptchaApplication imageCaptchaApplication;

    @Autowired
    private WebSshProperties properties;

    /**
     * 生成滑块验证码
     */
    @PostMapping("/get")
    public Map<String, Object> getCaptcha() {
        Map<String, Object> result = new HashMap<>();
        if (!properties.getCaptcha().isEnabled()) {
            result.put("code", 200);
            result.put("data", Collections.emptyMap());
            result.put("captchaEnabled", false);
            return result;
        }
        ApiResponse<ImageCaptchaVO> response = imageCaptchaApplication.generateCaptcha(CaptchaTypeConstant.SLIDER);
        if (response.isSuccess()) {
            result.put("code", 200);
            result.put("data", response.getData());
        } else {
            result.put("code", 500);
            result.put("msg", response.getMsg());
        }
        return result;
    }

    /**
     * 校验滑块验证码
     * 校验成功返回 token（即验证码 ID），供前端登录时二次校验使用
     */
    @PostMapping("/check")
    public Map<String, Object> checkCaptcha(@RequestBody CaptchaCheckDTO dto) {
        Map<String, Object> result = new HashMap<>();
        ApiResponse<?> response = imageCaptchaApplication.matching(dto.getId(), dto.getData());
        if (response.isSuccess()) {
            result.put("code", 200);
            result.put("data", Collections.singletonMap("token", dto.getId()));
        } else {
            result.put("code", 500);
            result.put("msg", response.getMsg());
        }
        return result;
    }

    public static class CaptchaCheckDTO {
        private String id;
        private ImageCaptchaTrack data;

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public ImageCaptchaTrack getData() {
            return data;
        }

        public void setData(ImageCaptchaTrack data) {
            this.data = data;
        }
    }
}