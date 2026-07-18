package com.webssh.util;

import jakarta.servlet.http.HttpSession;

import java.security.PrivateKey;
import java.util.Map;

/**
 * Session-aware RSA 助手
 * 桥接 core 模块 servlet-free 的 {@link RsaUtil} 与 starter 模块的 {@link HttpSession} API。
 *
 * <p>本类属于 starter 层（依赖 jakarta.servlet），调用方直接使用本类的静态方法即可，
 * 无需自行管理 {@code Map<String, PrivateKey>} 的 Session 存取。</p>
 *
 * <p>多版本适配：本类在 jakarta 版（3.x/4.x）与 javax 版（2.x）starter 中各有一份签名相同的实现，
 * 仅 import 包名不同（jakarta.servlet vs javax.servlet）。</p>
 *
 * @author webssh
 */
public final class RsaSessionHelper {
    private RsaSessionHelper() {
    }

    /**
     * 从 Session 中获取或创建私钥映射表
     */
    @SuppressWarnings("unchecked")
    private static Map<String, PrivateKey> getKeyMap(HttpSession session) {
        Map<String, PrivateKey> keyMap =
                (Map<String, PrivateKey>) session.getAttribute(RsaUtil.SESSION_RSA_KEY_MAP);
        if (keyMap == null) {
            keyMap = RsaUtil.newKeyMap();
            session.setAttribute(RsaUtil.SESSION_RSA_KEY_MAP, keyMap);
        }
        return keyMap;
    }

    /**
     * 将私钥存入 Session 的映射表，返回唯一的 keyId
     * 前端在加密时获取公钥和 keyId，解密时将 keyId 一并传回后端
     *
     * @param session    HttpSession
     * @param privateKey 要存储的私钥
     * @return keyId，用于后续解密时查找对应私钥
     */
    public static String storePrivateKey(HttpSession session, PrivateKey privateKey) {
        return RsaUtil.storePrivateKey(getKeyMap(session), privateKey);
    }

    /**
     * 从 Session 映射表中按 keyId 取出私钥解密密码，解密后移除该私钥（一次性使用）
     * 用于登录及新建会话等场景的密码加密传输
     *
     * @param session           HttpSession
     * @param encryptedPassword Base64 编码的密文，为空则返回 null（表示无需解密，回退到配置文件凭据）
     * @param keyId             公钥获取时返回的 keyId，用于查找对应私钥
     * @return 解密后的明文密码；密文为空时返回 null
     * @throws Exception 私钥不存在或解密失败时抛出
     */
    public static String decryptWithSessionKey(HttpSession session, String encryptedPassword,
                                                String keyId) throws Exception {
        return RsaUtil.decryptWithSessionKey(getKeyMap(session), encryptedPassword, keyId);
    }
}
