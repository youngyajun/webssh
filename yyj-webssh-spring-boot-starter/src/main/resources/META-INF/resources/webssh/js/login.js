// 从当前页面路径动态提取 contextPath（如 /webssh/login.html -> /webssh）
const contextPath = window.location.pathname.replace(/\/[^/]*$/, '');

// RSA 公钥（页面加载时从后端获取）
let rsaPublicKey = null;
// 公钥对应的 keyId，登录时回传后端用于查找私钥
let rsaKeyId = null;
// 登录锁定倒计时计时器
let lockCountdownTimer = null;

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
    const loading = document.getElementById('loading');

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

    // 使用 RSA 公钥加密密码
    const encrypt = new JSEncrypt();
    encrypt.setPublicKey(rsaPublicKey);
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
            body: JSON.stringify({ username, password: encryptedPassword, keyId: rsaKeyId })
        });
        const data = await response.json();
        if (data.code === 200) {
            clearLockCountdown();
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
            // 公钥已使用（一次性），需要重新获取
            rsaPublicKey = null;
            rsaKeyId = null;
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
});
