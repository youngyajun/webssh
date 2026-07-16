package com.webssh.util;

import jakarta.servlet.http.HttpSession;

import javax.crypto.Cipher;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.RSAKeyGenParameterSpec;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * RSA 加解密工具类
 * 用于登录密码的加密传输：前端用公钥加密，后端用私钥解密
 *
 * @author webssh
 */
public class RsaUtil {
    /**
     * Session 中存储 RSA 私钥映射表的 key
     * 使用 Map<keyId, PrivateKey> 支持并发加密请求，避免多标签页/多连接场景下的私钥覆盖问题
     */
    public static final String SESSION_RSA_KEY_MAP = "webssh_rsa_key_map";

    /**
     * RSA 密钥长度
     */
    private static final int KEY_SIZE = 2048;

    /**
     * 加解密算法，使用 PKCS1 填充
     */
    private static final String CIPHER_ALGORITHM = "RSA/ECB/PKCS1Padding";

    /**
     * 生成 RSA 密钥对
     *
     * @return RSA 密钥对
     * @throws Exception 生成失败时抛出
     */
    public static KeyPair generateKeyPair() throws Exception {
        KeyPairGenerator keyPairGenerator = KeyPairGenerator.getInstance("RSA");
        // 使用 F4 (65537) 作为公钥指数
        RSAKeyGenParameterSpec spec = new RSAKeyGenParameterSpec(KEY_SIZE, RSAKeyGenParameterSpec.F4);
        keyPairGenerator.initialize(spec);
        return keyPairGenerator.generateKeyPair();
    }

    /**
     * 获取公钥的 Base64 字符串（X.509 SubjectPublicKeyInfo 格式）
     * 前端 JSEncrypt 可直接使用
     *
     * @param publicKey 公钥
     * @return Base64 编码的公钥字符串
     */
    public static String getPublicKeyBase64(PublicKey publicKey) {
        return Base64.getEncoder().encodeToString(publicKey.getEncoded());
    }

    /**
     * 使用私钥解密 Base64 编码的密文
     *
     * @param privateKey     私钥
     * @param encryptedBase64 Base64 编码的密文
     * @return 解密后的明文
     * @throws Exception 解密失败时抛出
     */
    public static String decrypt(PrivateKey privateKey, String encryptedBase64) throws Exception {
        Cipher cipher = Cipher.getInstance(CIPHER_ALGORITHM);
        cipher.init(Cipher.DECRYPT_MODE, privateKey);
        byte[] decryptedBytes = cipher.doFinal(Base64.getDecoder().decode(encryptedBase64));
        return new String(decryptedBytes, java.nio.charset.StandardCharsets.UTF_8);
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
        Map<String, PrivateKey> keyMap = getKeyMap(session);
        String keyId = UUID.randomUUID().toString();
        keyMap.put(keyId, privateKey);
        return keyId;
    }

    /**
     * 从 Session 映射表中按 keyId 取出私钥解密密码，解密后移除该私钥（一次性使用）
     * 用于登录及新建会话等场景的密码加密传输
     *
     * @param session          HttpSession
     * @param encryptedPassword Base64 编码的密文，为空则返回 null（表示无需解密，回退到配置文件凭据）
     * @param keyId            公钥获取时返回的 keyId，用于查找对应私钥
     * @return 解密后的明文密码；密文为空时返回 null
     * @throws Exception 私钥不存在或解密失败时抛出
     */
    public static String decryptWithSessionKey(HttpSession session, String encryptedPassword,
                                               String keyId) throws Exception {
        if (encryptedPassword == null || encryptedPassword.isEmpty()) {
            return null;
        }
        Map<String, PrivateKey> keyMap = getKeyMap(session);
        PrivateKey privateKey = keyMap.remove(keyId);
        if (privateKey == null) {
            throw new IllegalStateException("公钥已过期，请刷新页面重试");
        }
        return decrypt(privateKey, encryptedPassword);
    }

    /**
     * 获取或创建 Session 中的私钥映射表
     */
    @SuppressWarnings("unchecked")
    private static Map<String, PrivateKey> getKeyMap(HttpSession session) {
        Map<String, PrivateKey> keyMap = (Map<String, PrivateKey>) session.getAttribute(SESSION_RSA_KEY_MAP);
        if (keyMap == null) {
            keyMap = new ConcurrentHashMap<>();
            session.setAttribute(SESSION_RSA_KEY_MAP, keyMap);
        }
        return keyMap;
    }
}
