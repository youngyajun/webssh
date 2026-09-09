// 从当前页面路径动态提取 contextPath（如 /webssh/login.html -> /webssh）
const contextPath = window.location.pathname.replace(/\/[^/]*$/, '');

// RSA 公钥（页面加载时从后端获取）
let rsaPublicKey = null;
// 公钥对应的 keyId，登录时回传后端用于查找私钥
let rsaKeyId = null;
// 登录锁定倒计时计时器
let lockCountdownTimer = null;
// 是否启用旋转验证码（从后端获取）
let captchaEnabled = true;
// 旋转验证成功后的二次验证 token，登录时回传后端
let captchaValidation = null;
// tianai-captcha 实例
let tacInstance = null;

const loginBtn = document.getElementById('loginBtn');
const errorMessage = document.getElementById('errorMessage');

/**
 * 输入框清除按钮：根据内容切换显示，点击清空并聚焦
 */
document.querySelectorAll('.input-wrapper').forEach(wrapper => {
    const input = wrapper.querySelector('input');
    const clearBtn = wrapper.querySelector('.clear-btn');
    // 根据是否有内容切换 has-value 类（控制清除按钮显隐）
    const sync = () => wrapper.classList.toggle('has-value', input.value.length > 0);
    sync();
    input.addEventListener('input', () => {
        sync();
        // 局部刷新校验：用户名和密码均已填写时，清除非空校验类的错误提示
        // 锁定倒计时期间不自动清除（保留锁定提示）
        if (!lockCountdownTimer) {
            const usernameVal = document.getElementById('username').value;
            const passwordVal = document.getElementById('password').value;
            if (usernameVal && passwordVal) {
                errorMessage.classList.remove('show');
            }
        }
    });
    clearBtn.addEventListener('click', () => {
        input.value = '';
        wrapper.classList.remove('has-value');
        input.focus();
    });
});

/**
 * 启动锁定倒计时，期间禁用登录按钮
 */
function startLockCountdown(seconds) {
    clearLockCountdown();
    let remaining = Math.max(1, Math.ceil(seconds));
    updateLockMessage(remaining);
    loginBtn.disabled = true;
    lockCountdownTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearLockCountdown();
            loginBtn.disabled = false;
            errorMessage.classList.remove('show');
            // 锁定结束，重新获取公钥
            fetchPublicKey();
        } else {
            updateLockMessage(remaining);
        }
    }, 1000);
}

/**
 * 更新锁定提示文案
 */
function updateLockMessage(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    const timeStr = min > 0 ? `${min}分${sec.toString().padStart(2, '0')}秒` : `${sec}秒`;
    errorMessage.textContent = `登录失败次数过多，已锁定，请于 ${timeStr} 后重试`;
    errorMessage.classList.add('show');
}

/**
 * 清除锁定倒计时
 */
function clearLockCountdown() {
    if (lockCountdownTimer) {
        clearInterval(lockCountdownTimer);
        lockCountdownTimer = null;
    }
}

/**
 * 获取 RSA 公钥
 * 公钥用于加密密码，私钥保留在后端 Session 中
 */
async function fetchPublicKey() {
    try {
        const response = await fetch(contextPath + '/auth/public-key');
        const data = await response.json();
        if (data.code === 200 && data.publicKey) {
            // 组装 PEM 格式公钥供 JSEncrypt 使用
            const pemBody = data.publicKey.match(/.{1,64}/g).join('\n');
            rsaPublicKey = '-----BEGIN PUBLIC KEY-----\n' + pemBody + '\n-----END PUBLIC KEY-----';
            rsaKeyId = data.keyId;
            // 读取验证码开关
            captchaEnabled = data.captchaEnabled !== undefined ? data.captchaEnabled : true;
            // 页面加载时若已被锁定，直接展示倒计时
            if (data.locked && data.lockRemainingSeconds) {
                startLockCountdown(data.lockRemainingSeconds);
            }
        }
    } catch (e) {
        console.error('获取公钥失败', e);
    }
}

// 页面加载时获取公钥
fetchPublicKey();

document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    // 处于锁定状态时禁止提交
    if (lockCountdownTimer) {
        return;
    }

    if (!username || !password) {
        errorMessage.textContent = '请输入用户名和密码';
        errorMessage.classList.add('show');
        return;
    }

    if (!rsaPublicKey || !rsaKeyId) {
        // 公钥未获取到，尝试重新获取
        await fetchPublicKey();
        if (!rsaPublicKey || !rsaKeyId) {
            errorMessage.textContent = '获取加密公钥失败，请刷新页面重试';
            errorMessage.classList.add('show');
            return;
        }
    }

    // 启用旋转验证码且尚未验证时，弹出验证码；验证成功后回调 doLogin
    if (captchaEnabled && !captchaValidation) {
        initCaptcha();
        return;
    }

    // 已验证或未启用验证码，执行登录
    doLogin();
});

/**
 * 校验 JSEncrypt 是否真正加载了服务端下发的 RSA 公钥
 *
 * setPublicKey() 没有返回值：传入空/假值时不会报错，而是等到 getKey() 时静默新建一把
 * 随机的 1024 位密钥，此后 encrypt() 会返回一段长度正常、但后端对应私钥无法解开的密文
 * （jsencrypt 3.3.2 及更早版本在此场景会返回 false，3.5.x 不会）。
 * 因此不能只依赖 encrypt() 的返回值，需回读已加载的公钥与服务端下发内容做比对，
 * 确保参与加密的模数确实是服务端持有私钥的那一把。
 *
 * @param {JSEncrypt} encrypt 已调用 setPublicKey 的实例
 * @param {string} expectedKey 服务端下发的公钥（PEM 或裸 Base64）
 * @returns {boolean} 公钥一致且可正常序列化时返回 true
 */
function isPublicKeyLoaded(encrypt, expectedKey) {
    const normalize = (key) => (key || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    let loaded;
    try {
        loaded = normalize(encrypt.getPublicKeyB64());
    } catch (e) {
        // 公钥解析失败时模数为 null，序列化会抛异常
        return false;
    }
    return !!loaded && loaded === normalize(expectedKey);
}

/**
 * 执行登录（携带旋转验证码二次验证 token）
 */
async function doLogin() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const loading = document.getElementById('loading');

    if (!rsaPublicKey || !rsaKeyId) {
        await fetchPublicKey();
        if (!rsaPublicKey || !rsaKeyId) {
            errorMessage.textContent = '获取加密公钥失败，请刷新页面重试';
            errorMessage.classList.add('show');
            return;
        }
    }

    // 使用 RSA 公钥加密密码
    const encrypt = new JSEncrypt();
    encrypt.setPublicKey(rsaPublicKey);
    // 回读校验，确保加密所用的公钥就是服务端持有私钥的那一把
    if (!isPublicKeyLoaded(encrypt, rsaPublicKey)) {
        errorMessage.textContent = '密码加密失败，请重试';
        errorMessage.classList.add('show');
        return;
    }
    const encryptedPassword = encrypt.encrypt(password);
    if (!encryptedPassword) {
        errorMessage.textContent = '密码加密失败，请重试';
        errorMessage.classList.add('show');
        return;
    }

    loginBtn.disabled = true;
    errorMessage.classList.remove('show');
    loading.classList.add('show');

    try {
        const response = await fetch(contextPath + '/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username,
                password: encryptedPassword,
                keyId: rsaKeyId,
                captchaValidation: captchaValidation
            })
        });
        const data = await response.json();
        if (data.code === 200) {
            clearLockCountdown();
            // 登录成功：清除上次保存的会话标签状态，确保登录后是干净状态（不自动恢复旧标签）
            // 浏览器刷新恢复不受影响（刷新时会话仍有效，不经过登录页）
            try { localStorage.removeItem('webssh_tabs_state'); } catch (e) {}
            window.location.href = contextPath + '/index.html';
        } else if (data.code === 429) {
            // 已被锁定，启动倒计时
            if (data.lockRemainingSeconds) {
                startLockCountdown(data.lockRemainingSeconds);
            } else {
                errorMessage.textContent = data.msg || '登录失败次数过多，请稍后再试';
                errorMessage.classList.add('show');
            }
        } else {
            let msg = data.msg || '登录失败';
            if (data.remainingAttempts !== undefined && data.remainingAttempts >= 0) {
                msg += `（剩余尝试次数 ${data.remainingAttempts} 次）`;
            }
            errorMessage.textContent = msg;
            errorMessage.classList.add('show');
            // 公钥已使用（一次性），需要重新获取；验证码也需重新完成
            rsaPublicKey = null;
            rsaKeyId = null;
            captchaValidation = null;
            fetchPublicKey();
        }
    } catch (error) {
        errorMessage.textContent = '网络错误，请重试';
        errorMessage.classList.add('show');
    } finally {
        // 锁定期间保持禁用
        if (!lockCountdownTimer) {
            loginBtn.disabled = false;
        }
        loading.classList.remove('show');
    }
}

/**
 * 初始化 tianai-captcha 旋转验证码
 * 弹出居中浮层，验证成功后设置 captchaValidation 并执行登录
 */
function initCaptcha() {
    // 销毁之前的验证码实例
    if (tacInstance) {
        tacInstance.destroyWindow();
        tacInstance = null;
    }
    // 显示遮罩层
    const overlay = document.getElementById('captcha-overlay');
    if (overlay) {
        overlay.classList.add('show');
    }
    const captchaConfig = {
        // 生成旋转验证码接口
        requestCaptchaDataUrl: contextPath + '/captcha/get',
        // 校验旋转验证码接口
        validCaptchaUrl: contextPath + '/captcha/check',
        // 验证码绑定的容器
        bindEl: '#captcha-box',
        // 验证成功回调
        validSuccess: (res, c, t) => {
            t.destroyWindow();
            tacInstance = null;
            hideCaptchaOverlay();
            // 保存二次验证 token，执行登录
            captchaValidation = res.data.token;
            doLogin();
        },
        // 验证失败回调
        validFail: (res, c, t) => {
            t.reloadCaptcha();
        },
        // 刷新按钮回调
        btnRefreshFun: (el, tac) => {
            tac.reloadCaptcha();
        },
        // 关闭按钮回调
        btnCloseFun: (el, tac) => {
            tac.destroyWindow();
            tacInstance = null;
            hideCaptchaOverlay();
        }
    };
    window
        .loadTAC(contextPath + '/tac', captchaConfig, { logoUrl: null })
        .then((tac) => {
            tacInstance = tac;
            tac.init();
        })
        .catch((e) => {
            errorMessage.textContent = '验证码加载失败，请重试';
            errorMessage.classList.add('show');
            hideCaptchaOverlay();
        });
}

/**
 * 隐藏验证码遮罩层
 */
function hideCaptchaOverlay() {
    const overlay = document.getElementById('captcha-overlay');
    if (overlay) {
        overlay.classList.remove('show');
    }
}
