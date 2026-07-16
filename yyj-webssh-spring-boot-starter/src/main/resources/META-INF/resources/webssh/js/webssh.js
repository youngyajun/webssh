/**
 * WebSSH 终端页面脚本
 * 处理终端连接、文件管理、标签切换、右键菜单等功能
 */

// 从当前页面路径动态提取 contextPath（如 /webssh/index.html -> /webssh）
const contextPath = window.location.pathname.replace(/\/[^/]*$/, '');

/**
 * 获取 RSA 公钥并加密密码
 * 每次调用都从后端获取新的公钥（私钥一次性使用），与登录页流程一致
 * @param password 明文密码
 * @returns {Promise<{encrypted: string, keyId: string}|null>} 加密结果，失败返回 null
 */
async function encryptPassword(password) {
    if (!password) return null;
    try {
        const resp = await fetch(contextPath + '/auth/public-key');
        const data = await resp.json();
        if (data.code !== 200 || !data.publicKey) return null;
        // 组装 PEM 格式公钥供 JSEncrypt 使用
        const pemBody = data.publicKey.match(/.{1,64}/g).join('\n');
        const pemKey = '-----BEGIN PUBLIC KEY-----\n' + pemBody + '\n-----END PUBLIC KEY-----';
        const encrypt = new JSEncrypt();
        encrypt.setPublicKey(pemKey);
        const encrypted = encrypt.encrypt(password);
        if (!encrypted) return null;
        return { encrypted: encrypted, keyId: data.keyId };
    } catch (e) {
        console.error('加密密码失败', e);
        return null;
    }
}
// 多标签管理
let tabs = [];                   // 标签页数组 {id, label, host, username, password, terminal, fitAddon, socket, connected, element}
let activeTabId = null;
let tabCounter = 0;
let ctxTabTargetId = null;       // 标签右键菜单目标 tabId
let draggedTabId = null;         // 拖拽排序中的源标签ID
// 分屏状态：null=单屏；否则为 { root: Node }（二叉树，支持最多 2 次嵌套分屏）
// Node = { leaf:true, tabId, domEl } | { leaf:false, direction:'h'|'v', children:[Node,Node], sizes:[pct,pct], domEl }
let splitState = null;
// 这些变量始终指向当前活跃标签页的对象，切换标签时同步
let terminal = null;
let fitAddon = null;             // xterm fit 插件，用于自适应容器尺寸
let socket = null;
let currentHost = '';
let currentPath = '/';
let fileSessionId = null;
let fileSessionReconnecting = false; // 文件会话自动重连中标志，防止检测到失效会话后反复重连
let terminalCwd = '/';          // 终端当前工作目录（用于路径同步）
let inputBuffer = '';            // 终端输入累积（用于识别 cd 命令）
let bufferReliable = true;       // 输入累积是否可靠（遇 Tab/方向键等转义则不可靠）
let cdTabDetected = false;       // cd 命令中按了 Tab，用于判断后续手动输入是否恢复可靠性
let followTerminalDir = false;   // 文件管理器是否跟随终端目录（默认关闭）
let suggestDebounceTimer = null; // 路径补全防抖定时器
let suggestionIndex = -1;       // 当前选中的建议项索引
let resizeDebounceTimer = null; // 终端 resize 防抖定时器
// 注：已发送的 PTY 尺寸按标签页独立追踪（tab.lastSentCols / tab.lastSentRows），
// 以支持分屏多面板各自同步尺寸，故不再使用全局变量
let hostsInfo = [];              // 主机信息列表
let credentialsCache = {};       // 凭据缓存
let restoringTabs = false;       // 正在从本地存储恢复会话标签，期间不自动弹凭据框
let reconnectPendingTabId = null; // 刷新后待重新输入凭据的标签页 id（恢复连接用）
// 终端字体大小范围（Ctrl+滚轮可调，每个标签页独立维护，新建标签用默认值 14）
const TERMINAL_FONT_SIZE_MIN = 6;
const TERMINAL_FONT_SIZE_MAX = 40;
const TERMINAL_FONT_SIZE_DEFAULT = 14;
let fontSizeHintTimer = null;    // 字体大小提示自动隐藏定时器

// ===== 终端主题预设 =====
const TERMINAL_THEMES = {
    'github-dark': {
        name: 'Dark',
        background: '#0d1117', foreground: '#c9d1d9', cursor: '#00ff00',
        selectionBackground: 'rgba(88, 166, 255, 0.3)',
        black: '#0d1117', red: '#ff7b72', green: '#3fb950',
        yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff',
        cyan: '#39c5cf', white: '#c9d1d9',
        brightBlack: '#484f58', brightRed: '#ffa198', brightGreen: '#56d364',
        brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
    'github-light': {
        name: 'Light',
        background: '#ffffff', foreground: '#24292f', cursor: '#00ff00',
        selectionBackground: 'rgba(4, 83, 178, 0.3)',
        black: '#24292f', red: '#cf222e', green: '#116329',
        yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df',
        cyan: '#1b7c83', white: '#6e7781',
        brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37',
        brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9',
        brightCyan: '#3192aa', brightWhite: '#8c959f',
    },
};
// 当前主题（从 localStorage 恢复，默认 github-dark）
let currentThemeName = localStorage.getItem('webssh_terminal_theme') || 'github-dark';

// 获取当前主题对象
function getTerminalTheme() {
    return TERMINAL_THEMES[currentThemeName] || TERMINAL_THEMES['github-dark'];
}

// 将主题应用到所有已打开的终端
function applyThemeToAllTabs(themeName) {
    currentThemeName = themeName;
    localStorage.setItem('webssh_terminal_theme', themeName);
    const theme = getTerminalTheme();
    tabs.forEach(tab => {
        if (tab.terminal) {
            tab.terminal.options.theme = theme;
        }
    });
    // 通过 data-theme 属性驱动 CSS 变量切换（文件管理器、标签栏、弹窗等跟随主题）
    document.body.setAttribute('data-theme', themeName === 'github-light' ? 'light' : 'dark');
    // 同步终端区域背景色与 xterm 主题背景精确匹配
    document.body.style.background = theme.background;
    const terminalPanel = document.querySelector('.terminal-panel');
    if (terminalPanel) terminalPanel.style.background = theme.background;
    const container = document.querySelector('.terminal-container');
    if (container) container.style.background = theme.background;
}

// 获取活跃标签页
function getActiveTab() { return tabs.find(t => t.id === activeTabId); }

// 实时输出判定窗口：已连接标签页在此时间内收到过终端输出，视为"正在实时输出"
// （覆盖 tail -f、top、日志跟随等持续/周期性输出场景）
const STREAMING_OUTPUT_THRESHOLD_MS = 5000;

// 检测是否存在正在实时输出内容的标签页（用于刷新/关闭前提示）
function hasActiveStreamingTab() {
    const now = Date.now();
    return tabs.some(t => t.connected && t.socket && t.lastOutputTime
        && (now - t.lastOutputTime < STREAMING_OUTPUT_THRESHOLD_MS));
}

// 通用确认对话框（基于 Promise），风格与页面自定义弹窗保持一致
function showConfirmDialog(message, { title = '确认', okText = '确定', okClass = 'btn-primary' } = {}) {
    return new Promise(resolve => {
        const modal = document.getElementById('confirmModal');
        document.getElementById('confirmTitle').textContent = title;
        document.getElementById('confirmMessage').textContent = message;
        const okBtn = document.getElementById('okConfirm');
        okBtn.textContent = okText;
        okBtn.className = 'btn ' + okClass;
        modal.classList.add('show');
        const cleanup = (result) => {
            modal.classList.remove('show');
            okBtn.onclick = null;
            document.getElementById('cancelConfirm').onclick = null;
            document.getElementById('closeConfirmModal').onclick = null;
            modal.onclick = null;
            resolve(result);
        };
        okBtn.onclick = () => cleanup(true);
        document.getElementById('cancelConfirm').onclick = () => cleanup(false);
        document.getElementById('closeConfirmModal').onclick = () => cleanup(false);
        // 点击背景遮罩关闭 = 取消
        modal.onclick = (e) => { if (e.target === e.currentTarget) cleanup(false); };
    });
}

// 同步全局变量到指定标签页（从标签页恢复到全局）
function syncGlobalsToTab(tab) {
    terminal = tab.terminal;
    fitAddon = tab.fitAddon;
    socket = tab.socket;
    currentHost = tab.host;
    fileSessionId = tab.fileSessionId;
    currentPath = tab.currentPath;
    terminalCwd = tab.terminalCwd;
    inputBuffer = tab.inputBuffer;
    bufferReliable = tab.bufferReliable;
    cdTabDetected = tab.cdTabDetected;
    followTerminalDir = tab.followTerminalDir;
}

// 保存当前全局变量到标签页（从全局保存到标签页）
function saveGlobalsToTab(tab) {
    if (!tab) return;
    tab.fileSessionId = fileSessionId;
    tab.currentPath = currentPath;
    tab.terminalCwd = terminalCwd;
    tab.inputBuffer = inputBuffer;
    tab.bufferReliable = bufferReliable;
    tab.cdTabDetected = cdTabDetected;
    tab.followTerminalDir = followTerminalDir;
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    // 初始化主题选择器
    const themeSelector = document.getElementById('themeSelector');
    themeSelector.value = currentThemeName;
    themeSelector.addEventListener('change', (e) => {
        applyThemeToAllTabs(e.target.value);
    });
    // 应用初始主题（同步页面背景色）
    applyThemeToAllTabs(currentThemeName);

    checkSession();
    bindEvents();
    initPathInput();
    bindTabEvents();
    initSplitDragHandlers();
    updateEmptyState();

    // 浏览器刷新/关闭前：兜底保存会话标签状态，确保恢复时拿到最新数据；
    // 若有标签页正在实时输出内容（tail -f、top、日志跟随等），弹出浏览器原生确认提示，避免误刷中断
    window.addEventListener('beforeunload', (event) => {
        saveTabsState();
        if (hasActiveStreamingTab()) {
            event.preventDefault();
            event.returnValue = '';
        }
    });
});

// 为标签页创建终端 DOM 和 xterm.js 实例
function createTerminalForTab(tabId) {
    const container = document.getElementById('terminalContainer');
    const el = document.createElement('div');
    el.id = 'terminal-' + tabId;
    el.className = 'tab-terminal';
    // 分屏拖放时据此识别目标面板所属标签
    el.dataset.tabId = tabId;
    container.appendChild(el);

    const term = new Terminal({
        cursorBlink: true,
        fontSize: TERMINAL_FONT_SIZE_DEFAULT,
        fontFamily: 'Consolas, "Courier New", monospace',
        theme: getTerminalTheme()
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);

    // Ctrl + 鼠标滚轮：放大/缩小终端字体（仅终端区域内生效，不影响浏览器页面缩放）
    // 每个标签页独立维护字号，互不影响；使用捕获阶段监听，确保先于 xterm 内部的
    // wheel 处理器执行，在按住 Ctrl 时阻止浏览器缩放页面、也阻止 xterm 滚动回滚缓冲
    el.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        const dir = e.deltaY < 0 ? 1 : -1;
        let newSize = (term.options.fontSize || TERMINAL_FONT_SIZE_DEFAULT) + dir;
        if (newSize < TERMINAL_FONT_SIZE_MIN) newSize = TERMINAL_FONT_SIZE_MIN;
        if (newSize > TERMINAL_FONT_SIZE_MAX) newSize = TERMINAL_FONT_SIZE_MAX;
        if (newSize === term.options.fontSize) {
            showFontSizeHint(newSize); // 已到上下限，仍提示当前值
            return;
        }
        term.options.fontSize = newSize;
        try { fit.fit(); } catch (err) { /* 容器未渲染好时忽略 */ }
        // 字体变化后行列数改变，同步发送新尺寸给后端伪终端
        if (terminal === term) {
            sendTerminalSize();
        }
        showFontSizeHint(newSize);
    }, { passive: false, capture: true });

    // 终端输入转发：始终发送到当前活跃标签页的 socket
    term.onData(data => {
        const at = getActiveTab();
        if (at && at.socket && at.socket.readyState === WebSocket.OPEN) {
            at.socket.send(data);
        }
        // 只追踪活跃标签页的输入（避免后台标签页数据干扰 cd 检测）
        if (activeTabId === tabId) {
            handleTerminalInput(data);
        }
    });

    return { element: el, terminal: term, fitAddon: fit };
}

// 创建新标签页
// pendingCredentials=true 时：创建"待重新输入凭据"的标签（用于刷新后恢复手动凭证会话），
// 不自动连接，待用户重新输入凭据后再连接
function createTab(host, username, password, rememberCredentials, pendingCredentials, switchToNew) {
    tabCounter++;
    const tabId = 'tab-' + tabCounter;
    const hostInfo = hostsInfo.find(h => h.name === host);
    const label = hostInfo ? hostInfo.name : host;

    const { element, terminal: term, fitAddon: fit } = createTerminalForTab(tabId);

    const tab = {
        id: tabId,
        label: label,
        host: host,
        username: username || (hostInfo ? (hostInfo.username || '') : ''),
        // 实际连接的 IP 和端口，用于状态栏显示 ssh://user@ip:port
        sshHost: hostInfo ? hostInfo.host : '',
        sshPort: hostInfo ? hostInfo.port : 22,
        password: password || '',
        terminal: term,
        fitAddon: fit,
        socket: null,
        connected: false,
        element: element,
        // 文件管理器状态（每个标签页独立隔离）
        fileSessionId: null,
        fileSessionConnected: false,
        currentPath: '/',
        terminalCwd: '/',
        inputBuffer: '',
        bufferReliable: true,
        cdTabDetected: false,
        followTerminalDir: false,
        // 断线自动重连状态
        reconnectAttempts: 0,
        reconnectTimer: null,
        reconnecting: false,
        manualClose: false,
        // 是否记住凭据用于重连（false 时断线不自动重连，需手动重新输入）
        rememberCredentials: rememberCredentials !== false,
        // 刷新恢复后是否需要用户重新输入凭据（手动凭证会话且未记住密码时）
        pendingCredentials: !!pendingCredentials,
        // 命令日志（记录用户在终端输入的每条命令）
        commandLog: [],
        // 最近一次收到终端输出的时间戳（用于检测 tail -f、top、日志跟随等实时输出）
        lastOutputTime: 0,
        // 已发送给后端的 PTY 尺寸（每标签独立，避免分屏多面板互相干扰）
        lastSentCols: 0,
        lastSentRows: 0
    };

    tabs.push(tab);
    renderTabBar();
    updateEmptyState();
    // 默认切换到新标签；后台复制会话（duplicateSession）传 false 以保留原分屏布局
    if (switchToNew !== false) {
        switchTab(tabId);
    }

    if (pendingCredentials) {
        // 刷新后恢复的手动凭证会话：凭据已失效，提示用户重新输入（切换至此标签时自动弹框）
        tab.pendingCredentials = true;
        tab.terminal.clear();
        tab.terminal.write('\x1b[33m会话已恢复，但刷新后凭据已失效。\x1b[0m\r\n');
        tab.terminal.write('\x1b[36m切换到此标签页时将自动弹出凭据输入框，重新输入后即可连接。\x1b[0m\r\n');
    } else {
        term.write('\x1b[33mWebSSH - 请选择主机连接\x1b[0m\r\n');
        // 自动连接终端
        connectSSHForTab(tab, username, password);
        // 为新标签页创建独立的文件会话
        connectFileSessionForTab(tab, username, password);
    }

    saveTabsState();
    return tab;
}

// 切换标签页
function switchTab(tabId) {
    const newTab = tabs.find(t => t.id === tabId);
    if (!newTab) return;

    // 点击当前已激活标签页：若处于"待重新输入凭据"状态，仍弹出凭据对话框
    // （凭据框未打开时才弹，避免重复弹框）
    if (newTab.id === activeTabId) {
        if (newTab.pendingCredentials && !restoringTabs &&
            !document.getElementById('credentialModal').classList.contains('show')) {
            openCredentialForPendingTab(newTab);
        }
        return;
    }

    const oldTab = getActiveTab();

    // 分屏工作区持久化：splitState 不随标签切换销毁，只显示/隐藏 splitWrapper。
    // 目标在分屏组内 → 确保分屏视图可见并切换焦点（focusSplitPane 内部完成状态同步与 UI 刷新）
    if (splitState && containsLeaf(splitState.root, tabId)) {
        // 从非分屏标签切回分屏组：隐藏非分屏标签终端
        if (oldTab && oldTab.element && !containsLeaf(splitState.root, oldTab.id)) {
            oldTab.element.classList.remove('active');
        }
        showSplitView();
        focusSplitPane(tabId);
        return;
    }

    // 目标不在分屏组 → 隐藏分屏视图（保留 splitState 与所有分屏 DOM），显示该标签单独终端
    if (splitState) {
        hideSplitView();
    }

    // 保存旧标签页的文件管理器状态
    saveGlobalsToTab(oldTab);

    // 隐藏旧终端：仅当旧终端不在分屏组里时才 remove active；
    // 分屏组标签的 active 由 renderSplitLayout 统一管理，切走时保留以便切回分屏视图时仍可见
    if (oldTab && oldTab.element && !(splitState && containsLeaf(splitState.root, oldTab.id))) {
        oldTab.element.classList.remove('active');
    }

    // 显示新终端
    activeTabId = tabId;
    newTab.element.classList.add('active');
    syncGlobalsToTab(newTab);
    newTab.lastSentCols = 0;
    newTab.lastSentRows = 0;

    // 适配终端尺寸
    if (newTab.fitAddon && newTab.terminal) {
        requestAnimationFrame(() => {
            try {
                newTab.fitAddon.fit();
                sendTerminalSize();
            } catch (e) { /* ignore */ }
        });
    }

    // 更新连接状态显示
    updateStatusBar(newTab);

    // 刷新文件管理器 UI 以反映新标签页的状态
    refreshFilePanelForTab(newTab);

    renderTabBar();

    // 切换到"待重新输入凭据"的标签页时，自动弹出凭据对话框
    if (newTab.pendingCredentials && !restoringTabs) {
        openCredentialForPendingTab(newTab);
    }

    // 切换标签页后同步监控信息显示（启停依据活跃标签页的文件会话）
    updateMonitorState();

    saveTabsState();
}

// 刷新文件管理器 UI 以匹配当前标签页状态
function refreshFilePanelForTab(tab) {
    // 更新跟随终端复选框
    const followCheckbox = document.getElementById('followTerminalDir');
    followCheckbox.checked = tab.followTerminalDir;

    // 更新路径显示（状态栏位于终端面板，应显示终端当前工作目录，而非文件管理器路径）
    document.getElementById('currentPath').textContent = '路径: ' + (tab.terminalCwd || '/');

    if (tab.pendingCredentials) {
        // 凭据已失效的恢复会话：文件会话尚未建立，需用户重新输入凭据后再连接
        document.getElementById('fileList').innerHTML =
            '<div class="empty-state">会话凭据已失效，请重新输入凭据后连接文件管理器</div>';
        renderBreadcrumb(tab.currentPath || '/');
        updatePathInput(tab.currentPath || '/');
    } else if (tab.fileSessionId) {
        // 已有文件会话，直接刷新文件列表和路径栏
        renderBreadcrumb(tab.currentPath || '/');
        updatePathInput(tab.currentPath || '/');
        loadFiles();
    } else if (tab.fileSessionConnected === false) {
        // 文件会话尚未建立（正在连接中）
        document.getElementById('fileList').innerHTML =
            '<div class="empty-state">正在连接文件会话...</div>';
        renderBreadcrumb(tab.currentPath || '/');
        updatePathInput(tab.currentPath || '/');
    } else {
        document.getElementById('fileList').innerHTML =
            '<div class="empty-state">未连接</div>';
    }
}

// 关闭标签页前二次确认，避免误关 SSH 会话导致连接意外断开
async function confirmCloseTab(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    const ok = await showConfirmDialog(
        `确定要关闭会话"${tab.label}"吗？关闭后该会话的连接将断开。`,
        { title: '关闭会话', okText: '关闭', okClass: 'btn-danger' }
    );
    if (ok) closeTab(tabId);
}

// 关闭标签页
function closeTab(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    // 若被关闭的标签处于分屏中，先从分屏树移除该面板（树塌缩为单叶时自动退出分屏）
    if (splitState && containsLeaf(splitState.root, tabId)) {
        removePaneAndCollapse(tabId);
    }

    // 标记为用户主动关闭，阻止断线重连；清除挂起的重连定时器
    tab.manualClose = true;
    if (tab.reconnectTimer) {
        clearTimeout(tab.reconnectTimer);
        tab.reconnectTimer = null;
    }

    // 先关闭 WebSocket
    if (tab.socket) {
        try { tab.socket.close(); } catch (e) { /* ignore */ }
    }

    // 断开文件会话
    if (tab.fileSessionId) {
        fetch(contextPath + '/api/disconnect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: tab.fileSessionId })
        }).catch(() => {});
    }

    // 销毁终端
    try { tab.terminal.dispose(); } catch (e) { /* ignore */ }
    if (tab.element && tab.element.parentNode) {
        tab.element.parentNode.removeChild(tab.element);
    }

    // 从数组中移除
    const idx = tabs.indexOf(tab);
    tabs.splice(idx, 1);

    // 如果关闭的是当前活跃标签页
    if (tabId === activeTabId) {
        if (tabs.length > 0) {
            // 切换到相邻标签页（复用 switchTab 逻辑，但 oldTab 已被移除）
            const newIdx = Math.min(idx, tabs.length - 1);
            activeTabId = null; // 重置以便 switchTab 能正常切换
            switchTab(tabs[newIdx].id);
        } else {
            activeTabId = null;
            terminal = null;
            fitAddon = null;
            socket = null;
            currentHost = '';
            fileSessionId = null;
            currentPath = '/';
            terminalCwd = '/';
            // 清空文件管理器 UI
            document.getElementById('fileList').innerHTML = '';
            document.getElementById('breadcrumb').innerHTML = '';
            document.getElementById('currentPath').textContent = '路径: -';
            // 无活跃标签页，停止监控
            stopMonitor();
        }
    }

    renderTabBar();
    updateEmptyState();
    saveTabsState();
}

// 复制会话
function duplicateSession(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    // 后台创建新标签，不切换焦点，保留当前分屏布局（参考 Xshell 复制会话行为）
    createTab(tab.host, tab.username, tab.password, tab.rememberCredentials, false, false);
}

// 为指定标签页连接文件会话（每个标签页独立隔离）
async function connectFileSessionForTab(tab, username, password) {
    if (!tab || !tab.host) return;
    tab.fileSessionConnected = false;
    const cachedCreds = getCachedCredentials(tab.host);
    const u = username || tab.username || (cachedCreds ? cachedCreds.username : '');
    const p = password || tab.password || (cachedCreds ? cachedCreds.password : '');
    const body = { host: tab.host };
    if (u) body.username = u;
    // 密码使用 RSA 加密后传输，与登录页流程一致
    if (p) {
        const enc = await encryptPassword(p);
        if (!enc) {
            if (tab.id === activeTabId) {
                document.getElementById('fileList').innerHTML =
                    '<div class="error-message">密码加密失败，请刷新页面重试</div>';
            }
            return;
        }
        body.password = enc.encrypted;
        body.keyId = enc.keyId;
    }

    fetch(contextPath + '/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
        .then(r => r.json())
        .then(data => {
            if (data.code === 200) {
                tab.fileSessionId = data.sessionId;
                tab.fileSessionConnected = true;
                // 如果当前是活跃标签页，同步到全局并刷新（syncInitialCwd 内部会调用 loadFiles，成功后重置重连标志）
                if (tab.id === activeTabId) {
                    fileSessionId = tab.fileSessionId;
                    syncInitialCwd();
                    // 文件会话就绪后启动服务器监控
                    updateMonitorState();
                } else {
                    fileSessionReconnecting = false;
                }
            } else {
                fileSessionReconnecting = false;
                if (tab.id === activeTabId) {
                    document.getElementById('fileList').innerHTML =
                        '<div class="error-message">' + (data.msg || '建立文件会话失败') + '</div>';
                }
            }
        })
        .catch(() => {
            fileSessionReconnecting = false;
            if (tab.id === activeTabId) {
                document.getElementById('fileList').innerHTML =
                    '<div class="error-message">建立文件会话失败</div>';
            }
        });
}

// 渲染标签栏
function renderTabBar() {
    const tabList = document.getElementById('tabList');
    tabList.innerHTML = tabs.map(t => {
        const activeClass = t.id === activeTabId ? ' active' : '';
        const connectedClass = t.connected ? ' connected' : '';
        // 分屏中非聚焦面板的标签：给予次级高亮，提示该会话仍可见
        const inSplitClass = (splitState && containsLeaf(splitState.root, t.id) && t.id !== activeTabId) ? ' in-split' : '';
        return `<div class="tab-item${activeClass}${connectedClass}${inSplitClass}" data-tab-id="${t.id}" title="${t.label} (${t.host})" draggable="true">
            <span class="tab-status${connectedClass}"></span>
            <span class="tab-label">${escapeHtml(t.label)}</span>
            <span class="tab-close" data-tab-close="${t.id}">&times;</span>
        </div>`;
    }).join('');

    // 绑定标签点击事件
    tabList.querySelectorAll('.tab-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.tab-close')) return;
            switchTab(item.dataset.tabId);
        });
        // 中键关闭
        item.addEventListener('auxclick', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                confirmCloseTab(item.dataset.tabId);
            }
        });
        // 右键菜单
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            ctxTabTargetId = item.dataset.tabId;
            showTabContextMenu(e);
        });
        // 拖拽排序：dragstart 记录源标签，关闭按钮上不触发拖拽
        item.addEventListener('dragstart', (e) => {
            if (e.target.closest('.tab-close')) {
                e.preventDefault();
                return;
            }
            draggedTabId = item.dataset.tabId;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggedTabId);
        });
        // dragover 根据鼠标位置显示左/右插入指示线
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (!draggedTabId || draggedTabId === item.dataset.tabId) return;
            // 清除其他标签的拖拽指示
            tabList.querySelectorAll('.tab-item').forEach(t => {
                t.classList.remove('drag-over-left', 'drag-over-right');
            });
            const rect = item.getBoundingClientRect();
            const midX = rect.left + rect.width / 2;
            if (e.clientX < midX) {
                item.classList.add('drag-over-left');
            } else {
                item.classList.add('drag-over-right');
            }
        });
        item.addEventListener('dragleave', () => {
            item.classList.remove('drag-over-left', 'drag-over-right');
        });
        // drop 时根据插入方向重排 tabs 数组
        item.addEventListener('drop', (e) => {
            e.preventDefault();
            if (!draggedTabId || draggedTabId === item.dataset.tabId) {
                cleanupDrag();
                return;
            }
            const rect = item.getBoundingClientRect();
            const insertBefore = e.clientX < rect.left + rect.width / 2;
            reorderTabs(draggedTabId, item.dataset.tabId, insertBefore);
            cleanupDrag();
        });
        item.addEventListener('dragend', cleanupDrag);
    });

    // 绑定关闭按钮事件
    tabList.querySelectorAll('.tab-close').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            confirmCloseTab(btn.dataset.tabClose);
        });
    });

    updateTabOverflow();
}

// 检测标签栏溢出，将超出宽度的标签折叠到下拉菜单中
let tabOverflowInited = false;
function updateTabOverflow() {
    const tabList = document.getElementById('tabList');
    const overflowBtn = document.getElementById('tabOverflowBtn');
    const overflowDropdown = document.getElementById('tabOverflowDropdown');
    if (!tabList || !overflowBtn || !overflowDropdown) return;

    // 一次性绑定溢出按钮点击与外部点击关闭
    if (!tabOverflowInited) {
        tabOverflowInited = true;
        overflowBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            overflowDropdown.classList.toggle('show');
        });
        document.addEventListener('click', (e) => {
            if (!overflowDropdown.contains(e.target) && e.target !== overflowBtn) {
                overflowDropdown.classList.remove('show');
            }
        });
    }

    const items = Array.from(tabList.querySelectorAll('.tab-item'));

    // 重置：全部显示，隐藏按钮
    items.forEach(item => { item.style.display = ''; });
    overflowBtn.style.display = 'none';

    const containerWidth = tabList.clientWidth;
    if (containerWidth <= 0 || tabList.scrollWidth <= containerWidth) {
        overflowDropdown.classList.remove('show');
        overflowDropdown.innerHTML = '';
        return;
    }

    // 有溢出，显示按钮并预留空间
    overflowBtn.style.display = 'flex';
    // 按钮显示后 flex 布局会自动缩小 tab-list，clientWidth 已为实际可用宽度
    const effectiveWidth = tabList.clientWidth;

    // 测量全部可见时各标签的右边界
    const bounds = items.map(item => ({
        id: item.dataset.tabId,
        el: item,
        right: item.offsetLeft + item.offsetWidth
    }));

    // 从后往前折叠溢出的非活跃标签
    const overflowedSet = new Set();
    for (let i = bounds.length - 1; i >= 0; i--) {
        if (bounds[i].right > effectiveWidth && bounds[i].id !== activeTabId) {
            overflowedSet.add(bounds[i].id);
            bounds[i].el.style.display = 'none';
        }
    }

    // 检查活跃标签是否仍溢出（前面标签已折叠，需重新测量）
    const activeBound = bounds.find(b => b.id === activeTabId);
    if (activeBound) {
        const activeEl = activeBound.el;
        if (activeEl.offsetLeft + activeEl.offsetWidth > effectiveWidth) {
            // 继续折叠活跃标签前面的非活跃可见标签，为活跃标签腾出空间
            const activeIdx = bounds.indexOf(activeBound);
            for (let i = activeIdx - 1; i >= 0; i--) {
                if (!overflowedSet.has(bounds[i].id)) {
                    overflowedSet.add(bounds[i].id);
                    bounds[i].el.style.display = 'none';
                    if (activeEl.offsetLeft + activeEl.offsetWidth <= effectiveWidth) break;
                }
            }
            // 若仍溢出，折叠活跃标签自身
            if (activeEl.offsetLeft + activeEl.offsetWidth > effectiveWidth) {
                overflowedSet.add(activeTabId);
                activeEl.style.display = 'none';
            }
        }
    }

    // 按原顺序收集折叠的标签
    const overflowedTabs = tabs.filter(t => overflowedSet.has(t.id));

    // 渲染下拉菜单
    overflowDropdown.innerHTML = overflowedTabs.map(t => {
        const activeClass = t.id === activeTabId ? ' active' : '';
        const connectedClass = t.connected ? ' connected' : '';
        return `<div class="tab-overflow-item${activeClass}" data-tab-id="${t.id}" title="${t.label} (${t.host})">
            <span class="tab-status${connectedClass}"></span>
            <span class="tab-label">${escapeHtml(t.label)}</span>
        </div>`;
    }).join('');

    // 活跃标签被折叠时按钮高亮提示
    overflowBtn.classList.toggle('has-active', overflowedSet.has(activeTabId));

    // 绑定下拉项点击：切换到对应标签
    overflowDropdown.querySelectorAll('.tab-overflow-item').forEach(item => {
        item.addEventListener('click', () => {
            switchTab(item.dataset.tabId);
            overflowDropdown.classList.remove('show');
        });
    });
}

// 清除所有拖拽相关样式并重置状态
function cleanupDrag() {
    draggedTabId = null;
    document.querySelectorAll('.tab-item').forEach(t => {
        t.classList.remove('dragging', 'drag-over-left', 'drag-over-right');
    });
}

// 重排 tabs 数组：将 draggedId 移动到 targetId 的前面或后面
function reorderTabs(draggedId, targetId, insertBefore) {
    const draggedIdx = tabs.findIndex(t => t.id === draggedId);
    const targetIdx = tabs.findIndex(t => t.id === targetId);
    if (draggedIdx < 0 || targetIdx < 0) return;
    // 移除被拖拽的标签
    const [draggedTab] = tabs.splice(draggedIdx, 1);
    // 重新查找目标索引（移除后可能变化）
    let newTargetIdx = tabs.findIndex(t => t.id === targetId);
    if (!insertBefore) newTargetIdx++;
    tabs.splice(newTargetIdx, 0, draggedTab);
    renderTabBar();
    saveTabsState();
}

// ======================== 分屏功能（类似 Xshell 拖拽分屏，支持最多 2 次嵌套） ========================
// 拖动标签栏的会话标签到终端区域，根据鼠标位置提示左/右/上/下分屏；
// 释放后目标面板与被拖标签组合显示。支持最多 2 次分屏（共 3 个面板），
// 第二次分屏时罗盘与预览阴影定位到被分屏的面板中心。布局采用二叉树模型：
//   Node = { leaf:true, tabId, domEl }
//        | { leaf:false, direction:'h'|'v', children:[Node,Node], sizes:[pct,pct], domEl }

// ---- 树操作辅助函数 ----
function makeLeaf(tabId) {
    return { leaf: true, tabId: tabId, domEl: null };
}
function containsLeaf(node, tabId) {
    if (!node) return false;
    if (node.leaf) return node.tabId === tabId;
    return containsLeaf(node.children[0], tabId) || containsLeaf(node.children[1], tabId);
}
function collectLeafTabIds(node) {
    if (!node) return [];
    if (node.leaf) return [node.tabId];
    return collectLeafTabIds(node.children[0]).concat(collectLeafTabIds(node.children[1]));
}
// 用 newNode 替换树中 tabId 等于 targetTabId 的叶子节点（原地改写为 split 节点）
function replaceLeaf(node, targetTabId, newNode) {
    if (!node) return false;
    if (node.leaf) {
        if (node.tabId === targetTabId) {
            node.leaf = false;
            node.tabId = undefined;
            node.direction = newNode.direction;
            node.children = newNode.children;
            node.sizes = newNode.sizes;
            node.domEl = null;
            return true;
        }
        return false;
    }
    return replaceLeaf(node.children[0], targetTabId, newNode) ||
           replaceLeaf(node.children[1], targetTabId, newNode);
}
// 从树中移除 tabId 对应的叶子，返回新节点：
//   null=树空；叶子=已塌缩为单叶（调用方应退出分屏）；split=保留
function removeLeaf(node, tabId) {
    if (!node) return null;
    if (node.leaf) {
        return node.tabId === tabId ? null : node;
    }
    const a = removeLeaf(node.children[0], tabId);
    const b = removeLeaf(node.children[1], tabId);
    if (a === null && b === null) return null;
    if (a === null) return b;
    if (b === null) return a;
    node.children[0] = a;
    node.children[1] = b;
    return node;
}
function firstLeafTabId(node) {
    if (!node) return null;
    if (node.leaf) return node.tabId;
    return firstLeafTabId(node.children[0]);
}
// 查找 tabId 的最近兄弟子树首个叶子（用于关闭面板后聚焦）。
// 递归到最深一层直接包含 tabId 的 split 节点，返回另一侧子树的首个叶子，
// 保证聚焦的是直接兄弟而非远亲。
function findSiblingLeafTabId(node, tabId) {
    if (!node || node.leaf) return null;
    const inLeft = containsLeaf(node.children[0], tabId);
    const inRight = containsLeaf(node.children[1], tabId);
    if (inLeft) {
        // 优先下钻到更深的 split 取直接兄弟；若 tabId 就在 children[0] 叶子，则取 children[1]
        const deeper = findSiblingLeafTabId(node.children[0], tabId);
        if (deeper) return deeper;
        return firstLeafTabId(node.children[1]);
    }
    if (inRight) {
        const deeper = findSiblingLeafTabId(node.children[1], tabId);
        if (deeper) return deeper;
        return firstLeafTabId(node.children[0]);
    }
    return null;
}
// 返回 tabId 对应叶子在树中的深度（根=0）；不存在返回 -1。
// 用于限制最大嵌套深度为 2：根=0，一级分屏的叶子=1（可再分），二级分屏的叶子=2（不可再分）
function leafDepth(node, tabId, depth) {
    if (!node) return -1;
    if (node.leaf) return node.tabId === tabId ? depth : -1;
    const d0 = leafDepth(node.children[0], tabId, depth + 1);
    if (d0 >= 0) return d0;
    return leafDepth(node.children[1], tabId, depth + 1);
}

// 计算拖放落点对应的分屏方向（相对传入的矩形）：left/right → 水平并排；top/bottom → 垂直堆叠
// 中心小块区域返回 null（避免误触），其余按到中心点的水平/垂直距离判定象限
function computeSplitZone(e, rect) {
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    // 中心区域不触发分屏，避免与正常标签切换冲突
    if (Math.abs(dx) < 36 && Math.abs(dy) < 36) return null;
    if (Math.abs(dx) > Math.abs(dy)) {
        return dx < 0 ? 'left' : 'right';
    }
    return dy < 0 ? 'top' : 'bottom';
}

// 确保 dragover 时的四向罗盘提示存在（惰性创建，pointer-events 不拦截 DnD 事件）
// 结构：位置预览阴影(.split-preview) + 居中 3x3 罗盘(上/下/左/右 四向始终可见，当前方向高亮)
function ensureSplitOverlay() {
    let ov = document.getElementById('splitDropOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'splitDropOverlay';
        ov.className = 'split-drop-overlay';
        ov.innerHTML =
            '<div class="split-preview"></div>' +
            '<div class="split-compass">' +
            '<div class="compass-cell cell-top" data-zone="top"><span class="arrow">↑</span><span>上</span></div>' +
            '<div class="compass-cell cell-left" data-zone="left"><span class="arrow">←</span><span>左</span></div>' +
            '<div class="compass-cell cell-center"></div>' +
            '<div class="compass-cell cell-right" data-zone="right"><span class="arrow">→</span><span>右</span></div>' +
            '<div class="compass-cell cell-bottom" data-zone="bottom"><span class="arrow">↓</span><span>下</span></div>' +
            '</div>';
        document.getElementById('terminalContainer').appendChild(ov);
    }
    return ov;
}

// 显示罗盘与预览阴影，overlay 覆盖目标面板区域（paneRect 为相对 terminalContainer 的矩形），
// 使罗盘居中于面板、预览阴影覆盖面板对应半区（嵌套分屏时定位到被分屏的面板中心）
function showSplitOverlay(zone, paneRect) {
    const ov = ensureSplitOverlay();
    // overlay 覆盖目标面板区域，使罗盘居中于面板、预览阴影覆盖面板半区
    ov.style.left = paneRect.left + 'px';
    ov.style.top = paneRect.top + 'px';
    ov.style.width = paneRect.width + 'px';
    ov.style.height = paneRect.height + 'px';
    // 罗盘方向高亮
    ov.querySelectorAll('.compass-cell').forEach(z => z.classList.remove('hover'));
    // 位置预览阴影：重置后按当前方向定位到对应半区
    const preview = ov.querySelector('.split-preview');
    preview.classList.remove('show', 'pos-left', 'pos-right', 'pos-top', 'pos-bottom');
    if (zone) {
        const el = ov.querySelector('.cell-' + zone);
        if (el) el.classList.add('hover');
        // 阴影位置 = 被拖标签落点所在的半区（left→左半、right→右半、top→上半、bottom→下半）
        preview.classList.add('show', 'pos-' + zone);
    }
    ov.classList.add('show');
}

function hideSplitOverlay() {
    const ov = document.getElementById('splitDropOverlay');
    if (ov) ov.classList.remove('show');
}

// 绑定终端容器的拖放事件：dragover 显示落点提示，drop 触发分屏
function initSplitDragHandlers() {
    const container = document.getElementById('terminalContainer');
    // 确定拖放目标面板：分屏模式下取鼠标所在 .split-pane，单屏模式下取整个容器
    function resolveTarget(e) {
        const paneEl = e.target.closest('.split-pane');
        const active = getActiveTab();
        let targetTabId, rectEl;
        if (paneEl && paneEl.dataset.tabId) {
            targetTabId = paneEl.dataset.tabId;
            rectEl = paneEl;
        } else {
            targetTabId = active ? active.id : null;
            rectEl = container;
        }
        return { targetTabId: targetTabId, rectEl: rectEl };
    }
    // 拒绝分屏的条件：拖动自身、拖动已在分屏树中的标签、目标叶子已达最大嵌套深度 2、
    // 分屏组已存在时对非分屏标签分屏（replaceLeaf 找不到目标叶子会失败，破坏树结构）
    function isRejected(targetTabId) {
        if (!targetTabId || draggedTabId === targetTabId) return true;
        if (splitState && containsLeaf(splitState.root, draggedTabId)) return true;
        // 分屏组已存在时，只能对分屏组内的面板再分屏；非分屏标签需先切回分屏组或退出分屏
        if (splitState && !containsLeaf(splitState.root, targetTabId)) return true;
        // 限制最大嵌套深度为 2：根=0，一级分屏的叶子=1（可再分），二级分屏的叶子=2（不可再分）
        // 这样每个一级面板都能各自子分一次，最多形成 4 面板 2×2 网格
        if (splitState && leafDepth(splitState.root, targetTabId, 0) >= 2) return true;
        return false;
    }
    container.addEventListener('dragover', (e) => {
        if (!draggedTabId) return;
        const { targetTabId, rectEl } = resolveTarget(e);
        if (isRejected(targetTabId)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = rectEl.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        showSplitOverlay(computeSplitZone(e, rect), {
            left: rect.left - cRect.left,
            top: rect.top - cRect.top,
            width: rect.width,
            height: rect.height
        });
    });
    container.addEventListener('dragleave', (e) => {
        if (!draggedTabId) return;
        // 仅当鼠标完全离开容器时隐藏提示
        const rect = container.getBoundingClientRect();
        if (e.clientX <= rect.left || e.clientX >= rect.right ||
            e.clientY <= rect.top || e.clientY >= rect.bottom) {
            hideSplitOverlay();
        }
    });
    container.addEventListener('drop', (e) => {
        if (!draggedTabId) return;
        const { targetTabId, rectEl } = resolveTarget(e);
        if (isRejected(targetTabId)) {
            hideSplitOverlay();
            return;
        }
        e.preventDefault();
        const zone = computeSplitZone(e, rectEl.getBoundingClientRect());
        hideSplitOverlay();
        if (!zone) return;
        enterSplitMode(draggedTabId, targetTabId, zone);
    });
    // 拖拽结束（无论是否成功）都隐藏提示
    document.addEventListener('dragend', hideSplitOverlay);
}

// 进入分屏模式（支持嵌套）：把 otherTabId 与 targetTabId 所在面板组合
// targetTabId 指定被分屏的面板：单屏时即活跃标签；已分屏时为拖放落点所在面板的标签
// zone 决定方向与被拖标签位置：left/top → 被拖标签在前；right/bottom → 被拖标签在后
function enterSplitMode(otherTabId, targetTabId, zone) {
    if (!otherTabId || !targetTabId || otherTabId === targetTabId) return;
    const otherTab = tabs.find(t => t.id === otherTabId);
    const targetTab = tabs.find(t => t.id === targetTabId);
    if (!otherTab || !targetTab) return;

    const direction = (zone === 'left' || zone === 'right') ? 'h' : 'v';
    const otherFirst = (zone === 'left' || zone === 'top');
    const childA = otherFirst ? makeLeaf(otherTabId) : makeLeaf(targetTabId);
    const childB = otherFirst ? makeLeaf(targetTabId) : makeLeaf(otherTabId);
    const newNode = {
        leaf: false,
        direction: direction,
        children: [childA, childB],
        sizes: [50, 50],
        domEl: null
    };

    if (!splitState) {
        // 首次分屏：新节点作为根
        splitState = { root: newNode };
    } else {
        // 嵌套分屏：用新 split 节点替换 targetTabId 对应的叶子
        replaceLeaf(splitState.root, targetTabId, newNode);
    }

    // 先保存原活跃标签的全局状态（输入缓冲、cwd 等），再切换焦点到被拖入的标签
    saveGlobalsToTab(getActiveTab());
    activeTabId = otherTabId;
    renderSplitLayout();
    const newTab = tabs.find(t => t.id === otherTabId);
    if (newTab) {
        syncGlobalsToTab(newTab);
        newTab.lastSentCols = 0;
        newTab.lastSentRows = 0;
        updateStatusBar(newTab);
        refreshFilePanelForTab(newTab);
        updateMonitorState();
    }
    renderTabBar();
    saveTabsState();
}

// 根据树重建分屏 DOM：先把所有终端元素移回容器，再递归构建并挂载根 wrapper
function renderSplitLayout() {
    const container = document.getElementById('terminalContainer');
    // 先把所有终端元素移回容器并移除 active，清理旧 DOM
    tabs.forEach(t => {
        if (t.element) {
            t.element.classList.remove('active');
            container.appendChild(t.element);
        }
    });
    const oldWrapper = document.getElementById('splitWrapper');
    if (oldWrapper) oldWrapper.remove();

    if (!splitState) return;

    // 递归构建 DOM，根 wrapper 标记 id 用于绝对填充定位
    splitState.root.domEl = buildNodeDom(splitState.root);
    splitState.root.domEl.id = 'splitWrapper';
    // 若当前活跃标签不在分屏组（用户切到了别的标签），分屏视图保持隐藏，
    // 避免重建的 splitWrapper 覆盖当前显示的非分屏标签终端
    if (!containsLeaf(splitState.root, activeTabId)) {
        splitState.root.domEl.classList.add('hidden');
    }
    container.appendChild(splitState.root.domEl);

    // 所有叶子面板的终端元素加 active（分屏 CSS 覆盖单屏 display 规则使其均可见）
    collectLeafTabIds(splitState.root).forEach(id => {
        const tab = tabs.find(t => t.id === id);
        if (tab && tab.element) tab.element.classList.add('active');
    });

    applySplitSizesAll(splitState.root);
    updateSplitPaneFocusBorders();
    // 下一帧再 fit，确保布局已应用
    requestAnimationFrame(() => fitSplitPanes());
}

// 递归构建节点 DOM，存入 node.domEl
function buildNodeDom(node) {
    if (node.leaf) {
        const pane = document.createElement('div');
        pane.className = 'split-pane';
        pane.dataset.tabId = node.tabId;
        pane.appendChild(createSplitPaneCloseBtn(node.tabId));
        const tab = tabs.find(t => t.id === node.tabId);
        if (tab && tab.element) pane.appendChild(tab.element);
        node.domEl = pane;
        bindSplitPaneFocus(pane, node.tabId);
        return pane;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'split-wrapper' + (node.direction === 'v' ? ' vertical' : '');
    const child0 = buildNodeDom(node.children[0]);
    const resizer = document.createElement('div');
    resizer.className = 'split-resizer';
    const child1 = buildNodeDom(node.children[1]);
    wrapper.appendChild(child0);
    wrapper.appendChild(resizer);
    wrapper.appendChild(child1);
    node.domEl = wrapper;
    bindSplitResizer(resizer, node);
    return wrapper;
}

// 创建分屏面板的关闭按钮（移除该面板，若树塌缩为单叶则退出分屏）
function createSplitPaneCloseBtn(tabId) {
    const btn = document.createElement('div');
    btn.className = 'split-pane-close';
    btn.title = '取消此面板分屏（会话保留在标签栏）';
    btn.innerHTML = '&times;';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!splitState) return;
        removePaneAndCollapse(tabId);
    });
    return btn;
}

// 移除某叶子面板并处理塌缩：若根变为单叶则退出分屏保留该叶子
function removePaneAndCollapse(tabId) {
    if (!splitState) return;
    const wasActive = (tabId === activeTabId);
    const siblingId = findSiblingLeafTabId(splitState.root, tabId);
    // 先保存当前活跃面板的全局状态（可能是被移除的面板）
    saveGlobalsToTab(getActiveTab());
    const newRoot = removeLeaf(splitState.root, tabId);
    if (!newRoot) {
        // 树空（理论上不会，至少 2 叶才会有关闭按钮）
        exitSplitMode(null);
        return;
    }
    if (newRoot.leaf) {
        // 塌缩为单叶：退出分屏，保留该叶子（exitSplitMode 内部完成焦点切换与 UI 刷新）
        exitSplitMode(newRoot.tabId);
        return;
    }
    splitState.root = newRoot;
    // 仅当关闭的是活跃面板时才需切换焦点到直接兄弟；否则保持当前焦点
    if (wasActive && siblingId) {
        activeTabId = siblingId;
        const t = tabs.find(t => t.id === siblingId);
        if (t) syncGlobalsToTab(t);
    }
    renderSplitLayout();
    // 切换了焦点时刷新相关 UI（状态栏、文件面板、监控、尺寸同步）
    if (wasActive && siblingId) {
        const t = tabs.find(t => t.id === siblingId);
        if (t) {
            updateStatusBar(t);
            refreshFilePanelForTab(t);
            updateMonitorState();
            sendTerminalSizeForTab(t);
        }
    }
    renderTabBar();
    saveTabsState();
}

// 显示分屏视图：从非分屏标签切回分屏组时调用，移除 hidden 并重新 fit
// （隐藏期间可能错过窗口 resize，切回时需重算所有面板尺寸）
function showSplitView() {
    const wrapper = document.getElementById('splitWrapper');
    if (!wrapper || !wrapper.classList.contains('hidden')) return;
    wrapper.classList.remove('hidden');
    requestAnimationFrame(() => fitSplitPanes());
}

// 隐藏分屏视图：切到非分屏标签时调用，保留 splitState 与所有分屏 DOM 不销毁
function hideSplitView() {
    const wrapper = document.getElementById('splitWrapper');
    if (wrapper) wrapper.classList.add('hidden');
}

// 退出分屏模式：拆解布局，把终端元素移回 #terminalContainer
// keepTabId 指定退出后保留为单屏的标签；skipActiveSync=true 时仅拆解、不切换活跃（供 switchTab 复用）
function exitSplitMode(keepTabId, opts) {
    opts = opts || {};
    if (!splitState) return;
    // 判断当前活跃标签是否在分屏组：若用户正在看非分屏标签（分屏视图隐藏中），
    // 拆解后不切焦点、不显示 keepTab，保持当前显示不变，分屏组标签转入后台
    const activeInSplit = containsLeaf(splitState.root, activeTabId);
    const container = document.getElementById('terminalContainer');
    // 把分屏内的终端元素移回主容器，并清除 active（由后续逻辑重新分配）
    collectLeafTabIds(splitState.root).forEach(id => {
        const tab = tabs.find(t => t.id === id);
        if (tab && tab.element) {
            tab.element.classList.remove('active');
            container.appendChild(tab.element);
        }
    });
    const wrapper = document.getElementById('splitWrapper');
    if (wrapper) wrapper.remove();
    splitState = null;

    // 用户当前在看非分屏标签：仅拆解分屏 DOM，不切焦点、不显示 keepTab
    if (!activeInSplit) return;

    if (opts.skipActiveSync) return;

    // 恢复保留标签为单屏显示
    if (keepTabId) {
        const keepTab = tabs.find(t => t.id === keepTabId);
        if (keepTab) {
            keepTab.element.classList.add('active');
            activeTabId = keepTab.id;
            syncGlobalsToTab(keepTab);
            keepTab.lastSentCols = 0;
            keepTab.lastSentRows = 0;
            renderTabBar();
            updateStatusBar(keepTab);
            refreshFilePanelForTab(keepTab);
            updateMonitorState();
            if (!opts.skipFit) {
                requestAnimationFrame(() => {
                    try { keepTab.fitAddon.fit(); } catch (e) { /* ignore */ }
                    sendTerminalSizeForTab(keepTab);
                });
            }
            saveTabsState();
        }
    }
}

// 分屏内切换聚焦面板（按 tabId，不隐藏/显示，仅更新活跃标签与全局变量）
function focusSplitPane(tabId) {
    if (!splitState || !containsLeaf(splitState.root, tabId)) return;
    if (tabId === activeTabId) return;
    const newTab = tabs.find(t => t.id === tabId);
    if (!newTab) return;

    // 先把当前活跃面板的全局状态（输入缓冲、cwd 等）保存回其标签页，避免被覆盖丢失
    saveGlobalsToTab(getActiveTab());

    activeTabId = tabId;
    syncGlobalsToTab(newTab);

    updateSplitPaneFocusBorders();
    updateStatusBar(newTab);
    refreshFilePanelForTab(newTab);
    renderTabBar();
    // 聚焦后确保该面板尺寸已同步（可能在切走期间错过 resize）
    sendTerminalSizeForTab(newTab);
    if (newTab.pendingCredentials && !restoringTabs) {
        openCredentialForPendingTab(newTab);
    }
    updateMonitorState();
    saveTabsState();
}

// 更新面板焦点边框：仅活跃叶子面板加 focused
function updateSplitPaneFocusBorders() {
    if (!splitState) return;
    const wrapper = document.getElementById('splitWrapper');
    if (!wrapper) return;
    wrapper.querySelectorAll('.split-pane').forEach(p => {
        p.classList.toggle('focused', p.dataset.tabId === activeTabId);
    });
}

// 绑定面板点击聚焦：点击面板任意区域即聚焦该面板（捕获阶段，先于终端处理）
function bindSplitPaneFocus(pane, tabId) {
    pane.addEventListener('mousedown', (e) => {
        if (e.target.closest('.split-pane-close')) return;
        focusSplitPane(tabId);
    }, true);
}

// 递归应用分屏比例到各节点子项 flex-basis（第 0 子项按百分比，第 1 子项填充剩余）。
// 直接使用 children 的 domEl 设置 flex，避免 :scope > .split-pane 在嵌套 wrapper
// 场景下只能匹配到 1 个 pane（另一侧是 .split-wrapper）导致 sizes 不生效、面板塌缩。
function applySplitSizesAll(node) {
    if (!node || node.leaf) return;
    const pct = Math.max(10, Math.min(90, node.sizes[0]));
    const a = node.children[0].domEl;
    const b = node.children[1].domEl;
    if (a && b) {
        a.style.flex = '0 0 ' + pct + '%';
        b.style.flex = '1 1 auto';
    }
    applySplitSizesAll(node.children[0]);
    applySplitSizesAll(node.children[1]);
}

// 绑定分隔条拖动：实时调整该节点分屏比例并节流 fit 所有面板（比例存于具体节点）
function bindSplitResizer(resizer, node) {
    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!splitState || !node.domEl) return;
        const isVertical = node.direction === 'v';
        const rect = node.domEl.getBoundingClientRect();
        let rafId = null;
        const move = (ev) => {
            let pct;
            if (isVertical) {
                pct = ((ev.clientY - rect.top) / rect.height) * 100;
            } else {
                pct = ((ev.clientX - rect.left) / rect.width) * 100;
            }
            pct = Math.max(10, Math.min(90, pct));
            node.sizes[0] = pct;
            applySplitSizesAll(node);
            // 节流 fit，避免每个 mousemove 都重算
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => fitSplitPanes());
        };
        const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            if (rafId) cancelAnimationFrame(rafId);
            fitSplitPanes();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    });
}

// fit 所有分屏面板并把新尺寸分别同步给各自后端通道
function fitSplitPanes() {
    if (!splitState) return;
    // splitWrapper 隐藏时跳过 fit（隐藏面板尺寸为 0 会导致终端行列数异常）
    const wrapper = document.getElementById('splitWrapper');
    if (wrapper && wrapper.classList.contains('hidden')) return;
    collectLeafTabIds(splitState.root).forEach(id => {
        const tab = tabs.find(t => t.id === id);
        if (tab && tab.fitAddon && tab.terminal) {
            try { tab.fitAddon.fit(); } catch (e) { /* ignore */ }
            sendTerminalSizeForTab(tab);
        }
    });
}

// 更新状态栏显示
function updateStatusBar(tab) {
    const statusEl = document.getElementById('connectionStatus');
    if (tab && tab.connected) {
        const sshUrl = buildSshUrl(tab);
        statusEl.innerHTML = '<span class="status-dot connected" id="statusDot"></span>' + escapeHtml(sshUrl);
        statusEl.title = sshUrl;
    } else {
        statusEl.innerHTML = '未连接';
        statusEl.title = '';
    }
}

// 构造 ssh://user@ip:port 格式的连接信息，用于状态栏显示
function buildSshUrl(tab) {
    let ip = tab.sshHost || '';
    let port = tab.sshPort || 22;
    if (!ip) {
        // 自定义主机：host 可能是 "IP:port" 格式
        const h = tab.host || '';
        const colonIdx = h.lastIndexOf(':');
        if (colonIdx > 0 && !h.substring(0, colonIdx).includes(':')) {
            ip = h.substring(0, colonIdx);
            const p = parseInt(h.substring(colonIdx + 1));
            if (p > 0 && p <= 65535) port = p;
        } else {
            ip = h;
        }
    }
    const user = tab.username || '';
    return 'ssh://' + user + '@' + ip + ':' + port;
}

// ===== 系统监控信息（CPU/RAM/Disk/Load/Net）=====
// 仅对当前活跃标签页的主机轮询，3 秒一次；切换/断开标签页时自动启停
let monitorTimer = null;
const MONITOR_INTERVAL = 3000;

// 根据当前活跃标签页状态启停监控
function updateMonitorState() {
    const tab = getActiveTab();
    if (tab && tab.fileSessionId) {
        startMonitor();
    } else {
        stopMonitor();
    }
}

function startMonitor() {
    // 已有定时器则不重复启动，但立即刷新一次以快速反映切换后的主机
    if (!monitorTimer) {
        monitorTimer = setInterval(fetchMonitor, MONITOR_INTERVAL);
    }
    fetchMonitor();
}

function stopMonitor() {
    if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
    }
    const el = document.getElementById('sysMonitor');
    if (el) el.classList.remove('show');
}

async function fetchMonitor() {
    const tab = getActiveTab();
    if (!tab || !tab.fileSessionId) {
        stopMonitor();
        return;
    }
    try {
        const resp = await fetch(contextPath + '/api/monitor?sessionId=' + encodeURIComponent(tab.fileSessionId));
        const data = await resp.json();
        if (data.code === 200 && data.data) {
            updateMonitorUI(data.data);
        } else if (data.code === 401) {
            // 会话失效，停止监控
            stopMonitor();
        }
    } catch (e) {
        // 网络异常等，静默忽略，下次轮询重试
    }
}

function updateMonitorUI(data) {
    const el = document.getElementById('sysMonitor');
    if (!el) return;
    const cpu = parseFloat(data.cpu) || 0;
    const mem = parseFloat(data.mem) || 0;
    const disk = parseFloat(data.disk) || 0;
    const load = parseFloat(data.load) || 0;
    const rx = parseInt(data.rx) || 0;
    const tx = parseInt(data.tx) || 0;
    const cls = v => v >= 90 ? 'mon-danger' : (v >= 75 ? 'mon-warn' : '');
    el.innerHTML =
        '<span class="mon-item ' + cls(cpu) + '" onclick="openMonitorDetail(\'cpu\')" title="点击查看 CPU 详情"><span class="mon-label">CPU</span><span class="mon-value">' + cpu.toFixed(0) + '%</span></span>' +
        '<span class="mon-sep">|</span>' +
        '<span class="mon-item ' + cls(mem) + '" onclick="openMonitorDetail(\'mem\')" title="点击查看 RAM 详情"><span class="mon-label">RAM</span><span class="mon-value">' + mem.toFixed(0) + '%</span></span>' +
        '<span class="mon-sep">|</span>' +
        '<span class="mon-item ' + cls(disk) + '" onclick="openMonitorDetail(\'disk\')" title="点击查看 Disk 详情"><span class="mon-label">Disk</span><span class="mon-value">' + disk.toFixed(0) + '%</span></span>' +
        '<span class="mon-sep">|</span>' +
        '<span class="mon-item" onclick="openMonitorDetail(\'load\')" title="点击查看 Load 详情"><span class="mon-label">Load</span><span class="mon-value">' + load.toFixed(2) + '</span></span>' +
        '<span class="mon-sep">|</span>' +
        '<span class="mon-item" onclick="openMonitorDetail(\'net\')" title="点击查看 Net 详情"><span class="mon-label">Net</span><span class="mon-value">↑' + formatNetRate(tx) + ' ↓' + formatNetRate(rx) + '</span></span>';
    el.classList.add('show');
}

function formatNetRate(bytes) {
    if (!bytes || bytes < 0) bytes = 0;
    if (bytes < 1024) return bytes + 'B/s';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB/s';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB/s';
    return (bytes / 1024 / 1024 / 1024).toFixed(1) + 'GB/s';
}

// ===== 监控详情弹窗（点击 CPU/RAM/Disk/Load/Net 打开，动态刷新）=====
let detailTimer = null;
let detailType = null;

function openMonitorDetail(type) {
    detailType = type;
    const titles = { cpu: 'CPU 详情', mem: 'RAM 详情', disk: 'Disk 详情', load: 'Load 详情', net: 'Net 详情' };
    document.getElementById('monitorDetailTitle').textContent = titles[type] || '监控详情';
    document.getElementById('monitorDetailContent').innerHTML = '<div class="detail-loading">加载中...</div>';
    document.getElementById('monitorDetailModal').classList.add('show');
    fetchMonitorDetail();
    if (detailTimer) clearInterval(detailTimer);
    detailTimer = setInterval(fetchMonitorDetail, 3000);
}

function closeMonitorDetail() {
    document.getElementById('monitorDetailModal').classList.remove('show');
    if (detailTimer) { clearInterval(detailTimer); detailTimer = null; }
    detailType = null;
}

async function fetchMonitorDetail() {
    if (!detailType) return;
    const tab = getActiveTab();
    if (!tab || !tab.fileSessionId) { closeMonitorDetail(); return; }
    try {
        const resp = await fetch(contextPath + '/api/monitor/detail?type=' + detailType + '&sessionId=' + encodeURIComponent(tab.fileSessionId));
        const data = await resp.json();
        if (data.code === 200 && data.data) {
            renderMonitorDetail(detailType, data.data);
        } else if (data.code === 401) {
            closeMonitorDetail();
        }
    } catch (e) { /* 网络异常静默，下次轮询重试 */ }
}

function renderMonitorDetail(type, d) {
    const el = document.getElementById('monitorDetailContent');
    let html = '';
    if (type === 'cpu') html = renderCpuDetail(d);
    else if (type === 'mem') html = renderMemDetail(d);
    else if (type === 'disk') html = renderDiskDetail(d);
    else if (type === 'load') html = renderLoadDetail(d);
    else if (type === 'net') html = renderNetDetail(d);
    el.innerHTML = html || '<div class="detail-loading">暂无数据</div>';
}

// ---- 详情渲染辅助函数 ----
function _parseLong(v) { const n = parseInt(v); return isNaN(n) ? 0 : n; }
function formatBytes(b) {
    if (!b || b < 0) b = 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
}
function _barColor(pct) {
    pct = parseFloat(pct) || 0;
    if (pct >= 90) return 'var(--danger)';
    if (pct >= 75) return '#d29922';
    return 'var(--accent)';
}
function _statCards(arr) {
    return '<div class="detail-stats">' + arr.map(function (kv) {
        const wide = kv[2] === true;
        return '<div class="stat-card' + (wide ? ' stat-card-wide' : '') + '"><div class="stat-label">' + kv[0] + '</div><div class="stat-value">' + kv[1] + '</div></div>';
    }).join('') + '</div>';
}
function _sectionTitle(t) { return '<div class="detail-section-title">' + t + '</div>'; }
function _progressRow(label, pct, unit, color) {
    pct = parseFloat(pct) || 0;
    const w = Math.min(100, Math.max(0, pct));
    return '<div class="progress-row"><span class="progress-label" title="' + label + '">' + label + '</span>' +
        '<div class="progress-bar"><div class="progress-fill" style="width:' + w + '%;background:' + color + '"></div></div>' +
        '<span class="progress-text">' + pct.toFixed(1) + unit + '</span></div>';
}
function _detailList(arr) {
    return '<table class="detail-table" style="margin-top:8px"><tbody>' + arr.map(function (kv) {
        return '<tr><td style="color:var(--text-muted)">' + kv[0] + '</td><td style="text-align:right">' + kv[1] + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function renderCpuDetail(d) {
    const usage = parseFloat(d.usage) || 0;
    const cores = parseInt(d.cores) || 0;
    const coreKeys = Object.keys(d).filter(function (k) { return /^cpu\d+$/.test(k); })
        .sort(function (a, b) { return parseInt(a.slice(3)) - parseInt(b.slice(3)); });
    let html = _statCards([
        ['型号', escapeHtml(d.model || '-'), true],
        ['核心数', cores],
        ['频率', d.freq ? (parseFloat(d.freq)).toFixed(0) + ' MHz' : '-'],
        ['运行时间', d.uptime_fmt || '-']
    ]);
    html += _sectionTitle('总体使用率');
    html += _progressRow('CPU', usage, '%', _barColor(usage));
    if (coreKeys.length > 0) {
        html += _sectionTitle('各核心使用率');
        coreKeys.forEach(function (k) {
            const v = parseFloat(d[k]) || 0;
            html += _progressRow('核心 ' + k.slice(3), v, '%', _barColor(v));
        });
    }
    return html;
}

function renderMemDetail(d) {
    // /proc/meminfo 返回值的单位为 kB，统一乘以 1024 转换为字节后再格式化
    const total = _parseLong(d.mem_total) * 1024;
    const avail = _parseLong(d.mem_available) * 1024;
    const used = total - avail;
    const free = _parseLong(d.mem_free) * 1024;
    const buffers = _parseLong(d.mem_buffers) * 1024;
    const cached = _parseLong(d.mem_cached) * 1024;
    const swapTotal = _parseLong(d.swap_total) * 1024;
    const swapFree = _parseLong(d.swap_free) * 1024;
    const swapUsed = swapTotal - swapFree;
    let html = _statCards([
        ['总内存', formatBytes(total)],
        ['已用', formatBytes(used)],
        ['可用', formatBytes(avail)],
        ['Swap 已用', formatBytes(swapUsed)]
    ]);
    const memPct = total > 0 ? (used / total * 100) : 0;
    html += _sectionTitle('内存使用');
    html += _progressRow('RAM', memPct, '%', _barColor(memPct));
    html += _detailList([['空闲', formatBytes(free)], ['缓冲(Buffers)', formatBytes(buffers)], ['缓存(Cached)', formatBytes(cached)]]);
    if (swapTotal > 0) {
        const swapPct = swapUsed / swapTotal * 100;
        html += _sectionTitle('Swap 使用');
        html += _progressRow('Swap', swapPct, '%', _barColor(swapPct));
        html += _detailList([['Swap 总量', formatBytes(swapTotal)], ['Swap 空闲', formatBytes(swapFree)]]);
    }
    return html;
}

function renderDiskDetail(d) {
    const parts = d.partitions || [];
    let html = _statCards([['分区数量', parts.length]]);
    if (parts.length === 0) return html + '<div class="detail-loading">无磁盘数据</div>';
    html += _sectionTitle('分区列表');
    html += '<table class="detail-table"><thead><tr><th>文件系统</th><th>总大小</th><th>已用</th><th>可用</th><th>使用率</th><th>挂载点</th></tr></thead><tbody>';
    parts.forEach(function (p) {
        const use = parseInt(p.use) || 0;
        html += '<tr><td>' + escapeHtml(p.fs) + '</td><td>' + formatBytes(p.size * 1024) + '</td><td>' + formatBytes(p.used * 1024) +
            '</td><td>' + formatBytes(p.avail * 1024) + '</td><td style="color:' + _barColor(use) + '">' + use + '%</td><td>' + escapeHtml(p.mount) + '</td></tr>';
    });
    html += '</tbody></table>';
    html += _sectionTitle('使用率');
    parts.forEach(function (p) {
        const use = parseInt(p.use) || 0;
        html += _progressRow(p.mount || p.fs, use, '%', _barColor(use));
    });
    return html;
}

function renderLoadDetail(d) {
    const cores = parseInt(d.cores) || 1;
    const l1 = parseFloat(d.load1) || 0;
    const l5 = parseFloat(d.load5) || 0;
    const l15 = parseFloat(d.load15) || 0;
    let html = _statCards([
        ['1分钟负载', l1.toFixed(2)],
        ['5分钟负载', l5.toFixed(2)],
        ['15分钟负载', l15.toFixed(2)],
        ['CPU核心数', cores],
        ['进程数', d.proc || '-'],
        ['运行时间', d.uptime_fmt || '-']
    ]);
    html += _sectionTitle('负载占比（相对核心数）');
    html += _progressRow('1分钟', l1 / cores * 100, '%', _barColor(l1 / cores * 100));
    html += _progressRow('5分钟', l5 / cores * 100, '%', _barColor(l5 / cores * 100));
    html += _progressRow('15分钟', l15 / cores * 100, '%', _barColor(l15 / cores * 100));
    return html;
}

function renderNetDetail(d) {
    const ifaces = d.interfaces || [];
    const totalRx = _parseLong(d.total_rx_rate);
    const totalTx = _parseLong(d.total_tx_rate);
    let html = _statCards([
        ['总下载速率', '↓ ' + formatNetRate(totalRx)],
        ['总上传速率', '↑ ' + formatNetRate(totalTx)],
        ['接口数量', ifaces.length]
    ]);
    if (ifaces.length === 0) return html + '<div class="detail-loading">无网络接口</div>';
    html += _sectionTitle('网络接口');
    html += '<table class="detail-table"><thead><tr><th>接口</th><th>接收(累计)</th><th>↓下载速率</th><th>发送(累计)</th><th>↑上传速率</th></tr></thead><tbody>';
    ifaces.forEach(function (it) {
        html += '<tr><td>' + escapeHtml(it.name) + '</td><td>' + formatBytes(it.rx) + '</td><td>' + formatNetRate(it.rxRate) +
            '</td><td>' + formatBytes(it.tx) + '</td><td>' + formatNetRate(it.txRate) + '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
}

// 详情弹窗关闭事件（关闭按钮 + 点击遮罩）
document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('closeMonitorDetail').addEventListener('click', closeMonitorDetail);
    const modal = document.getElementById('monitorDetailModal');
    modal.addEventListener('click', function (e) { if (e.target === modal) closeMonitorDetail(); });
});

// 标签栏相关事件（"+"按钮、右键菜单）
// 新建会话（统一入口：标签栏 + 按钮、空状态按钮、主机选择器）
function startNewSession(host) {
    if (!host) {
        const hostSelect = document.getElementById('hostSelector');
        host = hostSelect.value;
        if (!host && hostsInfo.length > 0) host = hostsInfo[0].name;
    }
    if (!host) {
        // 无配置主机时，直接打开凭据对话框供用户输入自定义主机/IP
        currentHost = '';
        showCredentialDialog();
        return;
    }

    currentHost = host;
    const hostInfo = hostsInfo.find(h => h.name === host);
    if (!hostInfo) {
        // 自定义主机（不在配置中），打开凭据对话框输入凭据
        showCredentialDialog();
        return;
    }
    const needCredentials = hostInfo.needCredentials;

    const cachedCreds = getCachedCredentials(host);
    if (needCredentials && !cachedCreds) {
        showCredentialDialog();
    } else if (needCredentials && cachedCreds) {
        connectFileSessionAsync(cachedCreds.username, cachedCreds.password).then(result => {
            if (result.success) {
                createTab(host, cachedCreds.username, cachedCreds.password, true);
            } else {
                delete credentialsCache[host];
                showCredentialDialog();
            }
        });
    } else {
        createTab(host, '', '');
    }
}

// 显示/隐藏空状态引导
function updateEmptyState() {
    const el = document.getElementById('terminalEmptyState');
    if (tabs.length === 0) {
        el.style.display = 'flex';
    } else {
        el.style.display = 'none';
    }
}

function bindTabEvents() {
    // 新建标签按钮
    document.getElementById('tabAddBtn').addEventListener('click', () => startNewSession());
    // 空状态"新建会话"按钮
    document.getElementById('emptyNewSessionBtn').addEventListener('click', () => startNewSession());

    // 标签右键菜单项
    document.getElementById('ctxTabRefresh').addEventListener('click', async () => {
        if (ctxTabTargetId) {
            const tab = tabs.find(t => t.id === ctxTabTargetId);
            if (tab) {
                // 非当前活跃标签，先切换到它再刷新，确保重连后终端正确显示
                if (tab.id !== activeTabId) switchTab(tab.id);
                refreshTab(tab);
            }
        }
        hideTabContextMenu();
    });
    document.getElementById('ctxTabDuplicate').addEventListener('click', () => {
        if (ctxTabTargetId) duplicateSession(ctxTabTargetId);
        hideTabContextMenu();
    });
    document.getElementById('ctxTabClose').addEventListener('click', async () => {
        const tabId = ctxTabTargetId;
        hideTabContextMenu();
        if (tabId) await confirmCloseTab(tabId);
    });
    document.getElementById('ctxTabCloseOthers').addEventListener('click', async () => {
        const tabId = ctxTabTargetId;
        hideTabContextMenu();
        if (!tabId) return;
        const others = tabs.filter(t => t.id !== tabId);
        if (others.length === 0) return;
        const ok = await showConfirmDialog(
            `确定要关闭其他 ${others.length} 个会话吗？关闭后这些会话的连接将断开。`,
            { title: '关闭其他会话', okText: '关闭', okClass: 'btn-danger' }
        );
        if (!ok) return;
        // 处于分屏时先退出：优先保留目标标签，否则保留当前活跃标签
        if (splitState) {
            exitSplitMode(containsLeaf(splitState.root, tabId) ? tabId : activeTabId);
        }
        // 先切换到要保留的标签，确保关闭其他后活跃标签正确
        if (activeTabId !== tabId) switchTab(tabId);
        others.forEach(t => closeTab(t.id));
    });
}

// 标签右键菜单显示
function showTabContextMenu(e) {
    const menu = document.getElementById('tabContextMenu');
    menu.style.display = 'block';
    menu.classList.add('show');

    // 只有一个标签时隐藏关闭按钮
    const closeOthers = document.getElementById('ctxTabCloseOthers');
    closeOthers.style.display = tabs.length <= 1 ? 'none' : 'flex';

    let x = e.clientX;
    let y = e.clientY;
    requestAnimationFrame(() => {
        const menuW = menu.offsetWidth;
        const menuH = menu.offsetHeight;
        if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 5;
        if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 5;
        if (x < 0) x = 5;
        if (y < 0) y = 5;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    });
}

function hideTabContextMenu() {
    const menu = document.getElementById('tabContextMenu');
    menu.classList.remove('show');
    menu.style.display = 'none';
    ctxTabTargetId = null;
}

// 全局点击关闭标签右键菜单
document.addEventListener('click', (e) => {
    if (!e.target.closest('.tab-context-menu') && !e.target.closest('.tab-item')) {
        hideTabContextMenu();
    }
});

function checkSession() {
    fetch(contextPath + '/auth/check')
        .then(r => r.json())
        .then(data => {
            if (!data.loggedIn) {
                window.location.href = contextPath + '/login.html';
            } else {
                document.getElementById('userInfo').textContent = data.username || '';
                loadHosts();
            }
        })
        .catch(() => {
            window.location.href = contextPath + '/login.html';
        });
}

function loadHosts() {
    fetch(contextPath + '/api/hosts/info')
        .then(r => r.json())
        .then(data => {
            hostsInfo = data.hosts || [];
            const selector = document.getElementById('hostSelector');
            // 下拉结构：占位符（不可再次选中）+ "新建会话"项（打开凭据对话框）+ 主机列表
            selector.innerHTML = '<option value="" selected disabled>选择主机...</option>' +
                '<option value="__new__">+ 新建会话</option>' +
                hostsInfo.map(host =>
                    `<option value="${host.name}" data-need-credentials="${host.needCredentials}">${host.name}</option>`
                ).join('');
            // 优先尝试从本地存储恢复上次刷新前的会话标签
            if (!restoreTabs()) {
                // 无保存的会话：不自动连接第一个主机，弹出凭据对话框让用户选择主机连接
                if (tabs.length === 0) {
                    currentHost = '';
                    selector.selectedIndex = 0;
                    showCredentialDialog();
                }
            }
        });
}

// 将会话标签状态持久化到 localStorage，用于浏览器刷新后恢复
// 注意：出于安全考虑，仅当标签页"记住凭据"（rememberCredentials=true）时才持久化密码；
// 未记住凭据的手动凭证会话，刷新后不会保存密码，需用户重新输入。
function saveTabsState() {
    try {
        const state = {
            activeTabId: activeTabId,
            tabs: tabs.map(t => ({
                id: t.id,
                label: t.label,
                host: t.host,
                sshHost: t.sshHost,
                sshPort: t.sshPort,
                username: t.username,
                // 仅当"记住凭据"时才持久化密码，否则刷新后需重新输入
                password: t.rememberCredentials ? (t.password || '') : '',
                rememberCredentials: t.rememberCredentials,
                pendingCredentials: !!t.pendingCredentials
            }))
        };
        localStorage.setItem('webssh_tabs_state', JSON.stringify(state));
    } catch (e) {
        // localStorage 不可用（隐私模式/配额超限）时忽略，不影响正常使用
    }
}

// 从本地存储恢复会话标签。返回 true 表示已恢复，false 表示无保存状态
function restoreTabs() {
    let raw;
    try { raw = localStorage.getItem('webssh_tabs_state'); } catch (e) { raw = null; }
    if (!raw) return false;
    let state;
    try { state = JSON.parse(raw); } catch (e) { return false; }
    if (!state || !Array.isArray(state.tabs) || state.tabs.length === 0) return false;

    restoringTabs = true;
    let restoredActiveId = null;
    let lastTabId = null;
    state.tabs.forEach(saved => {
        const hostInfo = hostsInfo.find(h => h.name === saved.host);
        const needCredentials = hostInfo ? hostInfo.needCredentials : true;
        let tab;
        if (!needCredentials) {
            // 已在配置文件配置账号密码：后端自动提供凭据，静默自动重连
            tab = createTab(saved.host, '', '', false);
        } else if (saved.rememberCredentials && saved.password) {
            // 手动输入且勾选"记住凭据"：使用持久化密码自动重连
            tab = createTab(saved.host, saved.username || '', saved.password || '', true);
        } else {
            // 手动输入但未记住凭据：创建待认证标签，稍后让用户重新输入
            tab = createTab(saved.host, saved.username || '', '', saved.rememberCredentials, true);
        }
        // 记录刚创建的标签 id，用于恢复活跃标签
        lastTabId = tab.id;
        if (saved.id === state.activeTabId) restoredActiveId = tab.id;
    });
    restoringTabs = false;

    // 切换到保存的活跃标签（未记录则取最后一个恢复的标签）；
    // switchTab 会自动为"待重新输入凭据"的活跃标签弹出凭据输入框
    const finalActiveId = restoredActiveId || lastTabId;
    if (finalActiveId) {
        switchTab(finalActiveId);
    }
    return true;
}

// 为刷新后"待重新输入凭据"的标签打开凭据对话框（预填主机与用户名）
function openCredentialForPendingTab(tab) {
    currentHost = tab.host;
    reconnectPendingTabId = tab.id;
    showCredentialDialog();
    if (tab.username) {
        document.getElementById('credentialUsername').value = tab.username;
    }
}

// 用用户重新输入的凭据恢复（连接）待认证标签，而非新建标签
function resumePendingTab(tabId, username, password, remember) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    tab.username = username;
    tab.password = password;
    tab.rememberCredentials = remember !== false;
    tab.pendingCredentials = false;
    // 重连终端与文件会话
    connectSSHForTab(tab, username, password);
    connectFileSessionForTab(tab, username, password);
    saveTabsState();
}

// 窗口尺寸变化时重新适配（防抖）——影响当前活跃终端
window.addEventListener('resize', () => {
    clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(() => {
        safeFit();
        updateTabOverflow();
    }, 100);
});

// 安全地执行 fit 并将新尺寸同步给后端 SSH 通道
function safeFit() {
    // 分屏视图可见时 fit 所有面板；隐藏时（用户在看非分屏标签）fit 当前标签终端
    if (splitState && containsLeaf(splitState.root, activeTabId)) {
        fitSplitPanes();
        return;
    }
    if (!terminal || !fitAddon) return;
    try {
        fitAddon.fit();
    } catch (e) {
        // 容器未渲染好时 fit 可能抛异常，忽略即可
        return;
    }
    sendTerminalSize();
}

// 将指定标签页的终端行列数发送给后端，后端据此调用 setPtySize 调整 SSH 伪终端
// 每个标签页独立追踪已发送尺寸，避免分屏多面板互相覆盖去重判断
function sendTerminalSizeForTab(tab) {
    if (!tab || !tab.socket || tab.socket.readyState !== WebSocket.OPEN) return;
    if (!tab.terminal) return;
    const cols = tab.terminal.cols;
    const rows = tab.terminal.rows;
    // 尺寸未变化则不重复发送
    if (cols === (tab.lastSentCols || 0) && rows === (tab.lastSentRows || 0)) return;
    tab.lastSentCols = cols;
    tab.lastSentRows = rows;
    tab.socket.send(JSON.stringify({ type: 'resize', cols: cols, rows: rows }));
}

// 将当前活跃标签页的终端尺寸同步给后端
function sendTerminalSize() {
    sendTerminalSizeForTab(getActiveTab());
}

// 在终端界面正中央短暂显示当前字体大小（Ctrl+滚轮调整时反馈）
function showFontSizeHint(size) {
    const container = document.getElementById('terminalContainer');
    if (!container) return;
    let hint = document.getElementById('fontSizeHint');
    if (!hint) {
        hint = document.createElement('div');
        hint.id = 'fontSizeHint';
        hint.className = 'font-size-hint';
        container.appendChild(hint);
    } else if (hint.parentElement !== container) {
        container.appendChild(hint);
    }
    hint.textContent = size + ' px';
    hint.classList.add('show');
    clearTimeout(fontSizeHintTimer);
    fontSizeHintTimer = setTimeout(() => {
        hint.classList.remove('show');
    }, 1200);
}

// 显示凭据输入对话框
function showCredentialDialog() {
    const modal = document.getElementById('credentialModal');
    const hostInfo = hostsInfo.find(h => h.name === currentHost);
    const needCredentials = hostInfo ? hostInfo.needCredentials : true;

    if (!needCredentials) {
        createTab(currentHost, '', '');
        return;
    }

    // 填充主机下拉建议列表（自定义下拉，用户可从中选择或自由输入 IP）
    const hostInput = document.getElementById('credentialHost');
    hostInput.value = currentHost;
    syncHostClearVisibility();
    // 输入框失焦且值变化时：更新 currentHost、清空凭据、刷新表单可见性
    hostInput.onchange = () => {
        currentHost = hostInput.value.trim();
        syncHostClearVisibility();
        document.getElementById('credentialUsername').value = '';
        document.getElementById('credentialPassword').value = '';
        document.getElementById('credentialError').style.display = 'none';
        document.getElementById('rememberCredentials').checked = false;
        updateCredentialFormVisibility();
        const newHostInfo = hostsInfo.find(h => h.name === currentHost);
        if (!newHostInfo || newHostInfo.needCredentials) {
            document.getElementById('credentialUsername').focus();
        }
    };
    // 初始填充并按当前值过滤下拉项
    populateHostDropdown(hostInput.value.trim());
    document.getElementById('credentialUsername').value = '';
    document.getElementById('credentialPassword').value = '';
    document.getElementById('credentialError').style.display = 'none';
    document.getElementById('rememberCredentials').checked = false;
    updateCredentialFormVisibility();
    // 重置提交按钮状态
    const submitBtn = document.getElementById('submitCredential');
    submitBtn.disabled = false;
    submitBtn.textContent = '连接';
    modal.classList.add('show');
    // 始终聚焦主机输入框（表单首项），并展开下拉便于选择或直接回车跳到用户名
    hostInput.focus();
}

// ======================== 主机组合框（自定义下拉，替代原生 datalist） ========================
// 支持自由输入 IP + 下拉选择已配置主机，提供过滤、键盘导航（↑↓/Enter/Esc）

// 根据主机输入框是否有内容，切换清空按钮的显隐（通过 has-value 类控制）
function syncHostClearVisibility() {
    const hostInput = document.getElementById('credentialHost');
    const combobox = hostInput.closest('.host-combobox');
    if (combobox) {
        combobox.classList.toggle('has-value', hostInput.value.length > 0);
    }
}

// 根据输入文本过滤并渲染下拉项
function populateHostDropdown(query) {
    const dropdown = document.getElementById('hostDropdown');
    const q = (query || '').trim().toLowerCase();
    // 过滤匹配主机（按 name 或 host 字段匹配）
    const matched = hostsInfo.filter(h => {
        if (!q) return true;
        const name = (h.name || '').toLowerCase();
        const host = (h.host || '').toLowerCase();
        return name.includes(q) || host.includes(q);
    });
    if (matched.length === 0) {
        dropdown.innerHTML = '<div class="host-dropdown-empty">无匹配主机，可直接输入 IP 后连接</div>';
        return;
    }
    dropdown.innerHTML = matched.map(h => {
        const meta = h.needCredentials ? '需凭据' : '已配置';
        return `<div class="host-dropdown-item" data-host="${h.name}">
            <span class="host-item-icon">&#9656;</span>
            <span class="host-item-name">${h.name}</span>
            <span class="host-item-meta">${meta}</span>
        </div>`;
    }).join('');
}

// 显示主机下拉
function showHostDropdown() {
    const dropdown = document.getElementById('hostDropdown');
    if (!dropdown.classList.contains('show')) {
        dropdown.classList.add('show');
    }
}

// 隐藏主机下拉
function hideHostDropdown() {
    document.getElementById('hostDropdown').classList.remove('show');
}

// 选中某个主机项：填入输入框、触发 onchange、隐藏下拉
function selectHostItem(hostName) {
    const hostInput = document.getElementById('credentialHost');
    hostInput.value = hostName;
    hideHostDropdown();
    // 触发 onchange 同步 currentHost 并刷新凭据表单
    hostInput.dispatchEvent(new Event('change'));
}

// 获取当前下拉项中激活项的索引（用于键盘导航）
function getActiveHostIndex() {
    const items = document.querySelectorAll('#hostDropdown .host-dropdown-item');
    for (let i = 0; i < items.length; i++) {
        if (items[i].classList.contains('active')) return i;
    }
    return -1;
}

// 设置激活项（高亮）
function setActiveHostItem(index) {
    const items = document.querySelectorAll('#hostDropdown .host-dropdown-item');
    items.forEach(it => it.classList.remove('active'));
    if (index >= 0 && index < items.length) {
        items[index].classList.add('active');
        items[index].scrollIntoView({ block: 'nearest' });
    }
}

// 根据当前所选主机是否已在配置文件中配置凭据，动态显示/隐藏凭据表单
function updateCredentialFormVisibility() {
    const hostInfo = hostsInfo.find(h => h.name === currentHost);
    // 自定义主机（不在配置中）始终需要输入凭据
    const needCredentials = hostInfo ? hostInfo.needCredentials : true;
    const usernameGroup = document.getElementById('credentialUsernameGroup');
    const passwordGroup = document.getElementById('credentialPasswordGroup');
    const rememberGroup = document.getElementById('rememberCredentialsGroup');
    const hint = document.getElementById('credentialConfiguredHint');
    if (needCredentials) {
        usernameGroup.style.display = '';
        passwordGroup.style.display = '';
        rememberGroup.style.display = '';
        hint.style.display = 'none';
    } else {
        usernameGroup.style.display = 'none';
        passwordGroup.style.display = 'none';
        rememberGroup.style.display = 'none';
        hint.style.display = 'block';
    }
}

// 关闭凭据对话框
function hideCredentialDialog() {
    document.getElementById('credentialModal').classList.remove('show');
    hideHostDropdown();
}

// 处理凭据提交（异步，等待文件会话建立结果）
async function submitCredentials() {
    // 始终从输入框读取最新主机值（支持自定义 IP 输入）
    currentHost = document.getElementById('credentialHost').value.trim();

    // 若当前主机已在配置文件中配置凭据，则直接创建会话，无需校验用户名/密码
    const curHostInfo = hostsInfo.find(h => h.name === currentHost);
    if (!reconnectPendingTabId && curHostInfo && !curHostInfo.needCredentials) {
        hideCredentialDialog();
        createTab(currentHost, '', '');
        return;
    }

    // 自定义主机或需要凭据的配置主机，校验用户名/密码
    if (!currentHost) {
        document.getElementById('credentialError').textContent = '请输入主机';
        document.getElementById('credentialError').style.display = 'block';
        return;
    }

    const username = document.getElementById('credentialUsername').value.trim();
    const password = document.getElementById('credentialPassword').value.trim();
    const remember = document.getElementById('rememberCredentials').checked;

    if (!username) {
        document.getElementById('credentialError').textContent = '请输入用户名';
        document.getElementById('credentialError').style.display = 'block';
        return;
    }

    if (!password) {
        document.getElementById('credentialError').textContent = '请输入密码';
        document.getElementById('credentialError').style.display = 'block';
        return;
    }

    // 禁用提交按钮，防止重复提交
    const submitBtn = document.getElementById('submitCredential');
    submitBtn.disabled = true;
    submitBtn.textContent = '连接中...';
    document.getElementById('credentialError').style.display = 'none';

    try {
        const result = await connectFileSessionAsync(username, password);

        if (result.success) {
            // 认证成功：缓存凭据、关闭对话框
            if (remember) {
                credentialsCache[currentHost] = { username, password };
            }
            hideCredentialDialog();
            if (reconnectPendingTabId) {
                // 恢复刷新前"待重新输入凭据"的标签，复用原标签而非新建
                const pendingId = reconnectPendingTabId;
                reconnectPendingTabId = null;
                resumePendingTab(pendingId, username, password, remember);
            } else {
                createTab(currentHost, username, password, remember);
            }
        } else if (result.authError) {
            // 认证失败：显示错误、保持对话框、允许重试
            document.getElementById('credentialError').textContent =
                'SSH 认证失败，用户名或密码错误';
            document.getElementById('credentialError').style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = '连接';
            // 清空密码，方便重新输入
            document.getElementById('credentialPassword').value = '';
            document.getElementById('credentialPassword').focus();
        } else {
            // 其他错误（网络、超时等）：显示在对话框中，允许重试
            document.getElementById('credentialError').textContent =
                result.msg || '连接失败，请检查网络或主机配置';
            document.getElementById('credentialError').style.display = 'block';
            submitBtn.disabled = false;
            submitBtn.textContent = '连接';
            document.getElementById('credentialPassword').value = '';
            document.getElementById('credentialPassword').focus();
        }
    } catch (err) {
        document.getElementById('credentialError').textContent = '连接失败: ' + err.message;
        document.getElementById('credentialError').style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = '连接';
    }
}

// 获取缓存的凭据
function getCachedCredentials(host) {
    return credentialsCache[host] || null;
}

// 刷新（重新连接）指定标签页的 SSH 会话，顶部刷新按钮与标签右键菜单共用
async function refreshTab(tab) {
    if (!tab) return;
    // 当前标签页正在实时输出时，提示确认避免中断（tail -f、top、日志跟随等）
    if (tab.connected && tab.socket && tab.lastOutputTime
        && (Date.now() - tab.lastOutputTime < STREAMING_OUTPUT_THRESHOLD_MS)) {
        const ok = await showConfirmDialog(
            '当前会话正在实时输出内容，重新连接将中断输出。确定要重新连接吗？',
            { title: '确认刷新', okText: '重新连接' }
        );
        if (!ok) return;
    }
    const hostInfo = hostsInfo.find(h => h.name === tab.host);
    // 自定义主机（不在配置中）始终需要凭据
    const needCredentials = hostInfo ? hostInfo.needCredentials : true;

    if (!needCredentials) {
        // 情况一：配置文件已配置 SSH 凭据的会话，后端自动提供凭据
        // 无需前端传递用户名/密码，直接重连即可（isReconnect=true：显示"正在重连"并重建文件会话）
        connectSSHForTab(tab, '', '', true);
        return;
    }

    // 情况二：需要用户提供凭据的会话
    // 优先使用内存缓存凭据，其次使用标签页保存的凭据（勾选"记住凭据"时持久化在 tab 上）
    const cachedCreds = getCachedCredentials(tab.host);
    const savedCreds = (tab.rememberCredentials && tab.password)
        ? { username: tab.username, password: tab.password } : null;
    const creds = cachedCreds || savedCreds;

    if (creds) {
        // 有可用凭据：同步到标签页（重连成功后文件会话也用此凭据重建），然后重连
        tab.username = creds.username;
        tab.password = creds.password;
        connectSSHForTab(tab, creds.username, creds.password, true);
    } else {
        // 无可用凭据：弹框让用户重新输入，提交后复用原标签重连（而非新建标签）
        openCredentialForPendingTab(tab);
    }
}

function bindEvents() {
    document.getElementById('hostSelector').addEventListener('change', (e) => {
        const host = e.target.value;
        // 重置为占位符，允许重复选择同一项创建多个会话
        e.target.selectedIndex = 0;
        if (host === '__new__') {
            // 选择"+ 新建会话"，打开凭据对话框供用户输入自定义主机/IP 或凭据
            currentHost = '';
            showCredentialDialog();
            return;
        }
        if (!host) return;
        startNewSession(host);
    });

    document.getElementById('toggleFilePanel').addEventListener('click', () => {
        const panel = document.getElementById('filePanel');
        const resizer = document.getElementById('resizer');
        // 清除拖拽产生的内联宽度，让 CSS class 控制宽度
        panel.style.width = '';
        panel.classList.toggle('collapsed');
        resizer.classList.toggle('collapsed');
        // 文件面板宽度变化后重新适配终端（过渡动画 300ms，稍延后触发）
        clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = setTimeout(safeFit, 320);
    });

    document.getElementById('followTerminalDir').addEventListener('change', (e) => {
        followTerminalDir = e.target.checked;
        if (followTerminalDir) {
            // 勾选后立即同步文件面板到终端当前目录，并启动轮询
            currentPath = terminalCwd;
            loadFiles();
            startFollowTimer();
        } else {
            stopFollowTimer();
        }
    });

    document.getElementById('refreshBtn').addEventListener('click', async () => {
        refreshTab(getActiveTab());
    });

    // 退出按钮：显示自定义确认对话框
    document.getElementById('logoutBtn').addEventListener('click', () => {
        document.getElementById('logoutModal').classList.add('show');
    });

    // 点击状态栏路径：复制终端当前工作目录到剪切板
    document.getElementById('currentPath').addEventListener('click', async () => {
        const text = (terminalCwd || '/').trim();
        if (!text) return;
        const el = document.getElementById('currentPath');
        let ok = false;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch (e) {
            // 降级方案：非 HTTPS 或浏览器不支持 clipboard API
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                ok = document.execCommand('copy');
            } catch (err) {
                ok = false;
            }
            document.body.removeChild(textarea);
        }
        // 视觉反馈：短暂显示“已复制”并高亮为绿色
        if (ok) {
            el.textContent = '已复制: ' + text;
            el.classList.add('copied');
            clearTimeout(el._copyFeedbackTimer);
            el._copyFeedbackTimer = setTimeout(() => {
                el.textContent = '路径: ' + (terminalCwd || '/');
                el.classList.remove('copied');
            }, 1200);
        }
    });

    // 退出确认对话框按钮事件
    document.getElementById('cancelLogout').addEventListener('click', () => {
        document.getElementById('logoutModal').classList.remove('show');
    });
    document.getElementById('closeLogoutModal').addEventListener('click', () => {
        document.getElementById('logoutModal').classList.remove('show');
    });
    document.getElementById('confirmLogout').addEventListener('click', () => {
        document.getElementById('logoutModal').classList.remove('show');
        // 登出后服务端 Session 失效，清除本地保存的会话标签，避免重新登录后恢复出无法连接的标签
        try { localStorage.removeItem('webssh_tabs_state'); } catch (e) {}
        // 关闭所有标签页的终端连接和文件会话
        tabs.forEach(t => {
            // 阻止断线重连；清除挂起的重连定时器
            t.manualClose = true;
            if (t.reconnectTimer) {
                clearTimeout(t.reconnectTimer);
                t.reconnectTimer = null;
            }
            if (t.socket) { try { t.socket.close(); } catch (e) {} }
            if (t.fileSessionId) {
                fetch(contextPath + '/api/disconnect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: t.fileSessionId })
                }).catch(() => {});
            }
        });
        // 通过 AJAX 调用登出 API 清理服务端 Session，避免服务端
        // sendRedirect 返回后端端口地址(8080)绕过前端代理(80)导致拒绝连接
        fetch(contextPath + '/auth/logout', { method: 'POST' })
            .catch(() => {})
            .finally(() => {
                window.location.href = contextPath + '/login.html';
            });
    });

    // 点击背景关闭退出对话框
    document.getElementById('logoutModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            e.currentTarget.classList.remove('show');
        }
    });

    document.getElementById('closePreview').addEventListener('click', () => {
        document.getElementById('previewModal').classList.remove('show');
    });

    // 凭据对话框事件处理
    // 关闭/取消时清除待恢复标签标记（用户放弃重新输入凭据，标签保持"待认证"状态，可稍后再次切换触发）
    document.getElementById('closeCredential').addEventListener('click', () => { reconnectPendingTabId = null; hideCredentialDialog(); });
    document.getElementById('cancelCredential').addEventListener('click', () => { reconnectPendingTabId = null; hideCredentialDialog(); });
    document.getElementById('submitCredential').addEventListener('click', submitCredentials);
    
    // 主机组合框：输入过滤、聚焦展开、键盘导航（↑↓/Enter/Esc）、点击选择
    const hostInput = document.getElementById('credentialHost');
    const hostDropdown = document.getElementById('hostDropdown');

    // 输入时实时过滤下拉项并展开
    hostInput.addEventListener('input', () => {
        populateHostDropdown(hostInput.value.trim());
        showHostDropdown();
        syncHostClearVisibility();
    });
    // 聚焦时展开下拉（按当前值过滤）
    hostInput.addEventListener('focus', () => {
        populateHostDropdown(hostInput.value.trim());
        showHostDropdown();
    });
    // 键盘导航：↓ 向下选择、↑ 向上选择、Enter 确认/跳转、Esc 关闭
    hostInput.addEventListener('keydown', (e) => {
        const items = document.querySelectorAll('#hostDropdown .host-dropdown-item');
        if (e.key === 'ArrowDown') {
            if (items.length === 0) return;
            e.preventDefault();
            showHostDropdown();
            let idx = getActiveHostIndex();
            idx = (idx + 1) % items.length;
            setActiveHostItem(idx);
        } else if (e.key === 'ArrowUp') {
            if (items.length === 0) return;
            e.preventDefault();
            showHostDropdown();
            let idx = getActiveHostIndex();
            idx = idx <= 0 ? items.length - 1 : idx - 1;
            setActiveHostItem(idx);
        } else if (e.key === 'Enter') {
            const idx = getActiveHostIndex();
            if (idx >= 0 && hostDropdown.classList.contains('show')) {
                // 有激活项时，选中该项
                e.preventDefault();
                selectHostItem(items[idx].dataset.host);
            } else {
                // 无激活项或下拉未展开时，跳转到用户名输入框
                e.preventDefault();
                hideHostDropdown();
                document.getElementById('credentialUsername').focus();
            }
        } else if (e.key === 'Escape') {
            hideHostDropdown();
        }
    });
    // 下拉项点击选择（用 mousedown 防止 input 失焦先于点击触发）
    hostDropdown.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.host-dropdown-item');
        if (item) {
            e.preventDefault();
            selectHostItem(item.dataset.host);
        }
    });
    // 清空按钮：清空主机输入并展开下拉展示全部主机
    // 用 mousedown + preventDefault 阻止 input 失焦，保持焦点在主机输入框
    document.getElementById('hostClearBtn').addEventListener('mousedown', (e) => {
        e.preventDefault();
        hostInput.value = '';
        syncHostClearVisibility();
        // 触发 onchange 同步 currentHost、清空凭据、刷新表单可见性
        hostInput.dispatchEvent(new Event('change'));
        // 展开下拉展示所有主机（onchange 可能聚焦到用户名，此处重新拉回主机输入框）
        populateHostDropdown('');
        showHostDropdown();
        hostInput.focus();
    });
    // 点击下拉外部时关闭
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.host-combobox')) {
            hideHostDropdown();
        }
    });

    document.getElementById('credentialUsername').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('credentialPassword').focus();
        }
    });
    
    document.getElementById('credentialPassword').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            submitCredentials();
        }
    });

    // 文件上传相关事件
    initUploadEvents();

    // 文件列表刷新按钮
    document.getElementById('refreshFileBtn').addEventListener('click', () => loadFiles());

    // 文件列表区域右键菜单（即使在空白区域也能唤出）
    document.getElementById('fileList').addEventListener('contextmenu', (e) => {
        if (e.target.closest('.file-item')) {
            // 如果右键在文件/目录项上，由 bindFileItemEvents 中的处理器负责
            return;
        }
        e.preventDefault();
        if (!fileSessionId) return;
        // 清除已有选中
        document.querySelectorAll('#fileList .file-item').forEach(i => i.classList.remove('selected'));
        showContextMenu(e, currentPath, true, true);
    });

    // 文件属性对话框关闭事件
    document.getElementById('closeProperties').addEventListener('click', hidePropertiesModal);
    document.getElementById('propertiesModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            hidePropertiesModal();
        }
    });

    // 文件夹大小警告对话框按钮事件
    document.getElementById('cancelLargeDir').addEventListener('click', () => {
        document.getElementById('largeDirModal').classList.remove('show');
        largeDirPending.path = null;
    });
    document.getElementById('closeLargeDirModal').addEventListener('click', () => {
        document.getElementById('largeDirModal').classList.remove('show');
        largeDirPending.path = null;
    });
    document.getElementById('confirmLargeDir').addEventListener('click', () => {
        document.getElementById('largeDirModal').classList.remove('show');
        if (largeDirPending.path) {
            downloadFile(largeDirPending.path, true);
            largeDirPending.path = null;
        }
    });
    // 点击背景关闭
    document.getElementById('largeDirModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            e.currentTarget.classList.remove('show');
            largeDirPending.path = null;
        }
    });

    // 点击页面其他区域关闭右键菜单
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.context-menu')) {
            hideContextMenu();
            hideTerminalContextMenu();
        }
    });

    // 滚动时关闭右键菜单
    document.getElementById('fileList').addEventListener('scroll', hideContextMenu);

    // 右键菜单项：上传文件（仅在空白区域右键时显示）
    document.getElementById('ctxUpload').addEventListener('click', () => {
        if (fileSessionId) {
            document.getElementById('hiddenFileInput').click();
        }
        hideContextMenu();
    });

    // 右键菜单项：下载（文件夹先检查大小）
    document.getElementById('ctxDownload').addEventListener('click', () => {
        if (contextMenuTarget.path) {
            if (contextMenuTarget.isDir) {
                checkDirSizeBeforeDownload(contextMenuTarget.path);
            } else {
                downloadFile(contextMenuTarget.path, false);
            }
        }
        hideContextMenu();
    });

    // 右键菜单项：预览
    document.getElementById('ctxPreview').addEventListener('click', () => {
        if (contextMenuTarget.path && !contextMenuTarget.isDir) {
            previewFile(contextMenuTarget.path);
        }
        hideContextMenu();
    });

    // 右键菜单项：属性
    document.getElementById('ctxProperties').addEventListener('click', () => {
        if (contextMenuTarget.path) {
            showFileProperties(contextMenuTarget.path);
        }
        hideContextMenu();
    });

    // 终端区域右键菜单（复制）
    document.getElementById('terminalContainer').addEventListener('contextmenu', (e) => {
        if (!terminal) return;
        terminalSelection = terminal.getSelection();
        if (!terminalSelection) return; // 没有选中文本不显示菜单
        e.preventDefault();
        showTerminalContextMenu(e);
    });

    // 终端右键菜单项：复制
    document.getElementById('ctxCopy').addEventListener('click', async () => {
        if (terminalSelection) {
            try {
                await navigator.clipboard.writeText(terminalSelection);
            } catch (e) {
                // 降级方案：非 HTTPS 或浏览器不支持 clipboard API
                const textarea = document.createElement('textarea');
                textarea.value = terminalSelection;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                try {
                    document.execCommand('copy');
                } catch (err) { /* ignore */ }
                document.body.removeChild(textarea);
            }
        }
        hideTerminalContextMenu();
    });

    // 文件面板拖拽调整宽度
    initResizer();

    // 命令日志按钮：打开日志弹窗
    document.getElementById('logBtn').addEventListener('click', showCommandLog);
    document.getElementById('closeLogModal').addEventListener('click', () => {
        document.getElementById('logModal').classList.remove('show');
    });
    document.getElementById('clearLogBtn').addEventListener('click', clearCommandLog);
    document.getElementById('copyLogBtn').addEventListener('click', copyCommandLog);
    // 点击背景关闭命令日志弹窗
    document.getElementById('logModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            e.currentTarget.classList.remove('show');
        }
    });

    // 终端日志按钮：导出终端界面显示内容
    document.getElementById('terminalLogBtn').addEventListener('click', showTerminalLog);
    document.getElementById('closeTerminalLogModal').addEventListener('click', () => {
        document.getElementById('terminalLogModal').classList.remove('show');
    });
    document.getElementById('downloadTerminalLogBtn').addEventListener('click', downloadTerminalLog);
    // 点击背景关闭终端日志弹窗
    document.getElementById('terminalLogModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            e.currentTarget.classList.remove('show');
        }
    });

    // 终端输入处理已在 createTerminalForTab 中绑定
}

async function connectSSHForTab(tab, username, password, isReconnect) {
    if (!tab || !tab.host) return;
    // 清除可能挂起的重连定时器
    if (tab.reconnectTimer) {
        clearTimeout(tab.reconnectTimer);
        tab.reconnectTimer = null;
    }
    if (tab.socket) {
        // 标记旧连接为手动关闭，防止其 onclose 触发重连
        tab.manualClose = true;
        try { tab.socket.close(); } catch (e) { /* ignore */ }
        tab.manualClose = false;
    }
    if (!isReconnect) {
        tab.terminal.clear();
        tab.terminal.write(`\x1b[33m正在连接 ${tab.host}...\x1b[0m\r\n`);
    } else {
        tab.terminal.write(`\x1b[33m正在重连 ${tab.host}...\x1b[0m\r\n`);
    }

    // 握手前先 fit 一次，把初始 cols/rows 通过 URL 传给后端，
    // 后端在 channel.connect() 前据此设置初始 PTY 尺寸，避免 vim 等全屏程序
    // 在 resize 消息到达前以默认 80x24 启动导致内容只填充左上角小块区域
    let initialCols = 80;
    let initialRows = 24;
    try {
        tab.fitAddon.fit();
        initialCols = Math.max(1, tab.terminal.cols);
        initialRows = Math.max(1, tab.terminal.rows);
    } catch (e) { /* 容器未渲染好时使用默认值 */ }

    // 构建WebSocket URL，包含凭据参数和初始终端尺寸
    let wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${contextPath}/ws?host=${encodeURIComponent(tab.host)}`;
    wsUrl += `&cols=${initialCols}&rows=${initialRows}`;
    if (username) {
        wsUrl += `&username=${encodeURIComponent(username)}`;
    }
    // 密码使用 RSA 加密后传输，与登录页流程一致
    if (password) {
        const enc = await encryptPassword(password);
        if (enc) {
            wsUrl += `&password=${encodeURIComponent(enc.encrypted)}`;
            wsUrl += `&keyId=${encodeURIComponent(enc.keyId)}`;
        }
    }

    tab.socket = new WebSocket(wsUrl);
    tab.socket.onopen = () => {
        tab.connected = true;
        tab.reconnectAttempts = 0;
        tab.reconnecting = false;
        if (!isReconnect) {
            tab.terminal.clear();
        } else {
            tab.terminal.write('\r\n\x1b[32m重连成功\x1b[0m\r\n');
            // 终端重连成功后，文件会话可能已失效（服务端重启），主动重建
            if (tab.fileSessionId) {
                const oldSessionId = tab.fileSessionId;
                tab.fileSessionId = null;
                tab.fileSessionConnected = false;
                if (tab.id === activeTabId) {
                    fileSessionId = null;
                }
                // 异步断开旧会话（可能已失效，失败也无影响）
                fetch(contextPath + '/api/disconnect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: oldSessionId })
                }).catch(() => {});
                // 使用标签页保存的凭据重建文件会话
                connectFileSessionForTab(tab, tab.username, tab.password);
            }
        }
        // 更新状态栏和标签
        if (tab.id === activeTabId) {
            updateStatusBar(tab);
        }
        renderTabBar();
        // 连接建立后立即同步终端尺寸给后端：先同步发送一次（保证 vim 等全屏程序
        // 启动前 PTY 尺寸已正确），再用 requestAnimationFrame 兜底处理容器异步渲染
        const inSplit = splitState && containsLeaf(splitState.root, tab.id);
        if (tab.id === activeTabId || inSplit) {
            // switchTab 发生在 socket 创建之前，全局 socket 此前还是旧值或 null，
            // 这里同步为当前 tab 的实例，确保 sendTerminalSize 走当前连接
            if (tab.id === activeTabId) {
                socket = tab.socket;
                terminal = tab.terminal;
                fitAddon = tab.fitAddon;
            }
            tab.lastSentCols = 0;
            tab.lastSentRows = 0;
            // 立即同步发送当前尺寸（已在握手前 fit 过，cols/rows 可用）
            sendTerminalSizeForTab(tab);
            // 兜底：下一帧再 fit 一次，覆盖容器尺寸尚未稳定的情况。
            // safeFit 内部按分屏视图可见性自动选择 fit 所有面板或仅活跃终端
            requestAnimationFrame(() => {
                safeFit();
            });
        }
    };
    tab.socket.onmessage = (event) => {
        tab.lastOutputTime = Date.now();
        tab.terminal.write(event.data);
    };
    tab.socket.onclose = (event) => {
        // 忽略已被新连接替换的旧 socket 的关闭事件
        if (event.target !== tab.socket) return;
        tab.connected = false;
        if (tab.id === activeTabId) {
            document.getElementById('connectionStatus').innerHTML = '未连接';
            // 终端断开时停止监控，重连成功后由文件会话重建回调恢复
            stopMonitor();
        }
        tab.terminal.write('\r\n\x1b[31m连接已断开\x1b[0m\r\n');
        renderTabBar();
        // 非用户主动关闭时触发自动重连
        if (!tab.manualClose) {
            attemptReconnect(tab);
        }
    };
    tab.socket.onerror = (event) => {
        // 忽略已被新连接替换的旧 socket 的错误事件
        if (event.target !== tab.socket) return;
        tab.connected = false;
        if (tab.id === activeTabId) {
            document.getElementById('connectionStatus').innerHTML = '连接错误';
        }
        // onerror 后通常紧跟 onclose，由 onclose 统一处理重连
        tab.terminal.write('\r\n\x1b[31m连接错误\x1b[0m\r\n');
        renderTabBar();
    };
}

// 断线自动重连：指数退避策略，最多重试 5 次
function attemptReconnect(tab) {
    const maxAttempts = 5;
    const baseDelay = 2000; // 初始 2 秒

    // 未记住凭据的手动认证主机：不自动重连，需用户手动重新输入凭据
    if (!tab.rememberCredentials && tab.username) {
        tab.reconnecting = false;
        tab.terminal.write('\r\n\x1b[31m连接已断开。由于未选择"记住凭据"，凭据未保留，无法自动重连。\x1b[0m\r\n');
        tab.terminal.write('\x1b[33m请点击工具栏的刷新按钮重新输入凭据连接。\x1b[0m\r\n');
        if (tab.id === activeTabId) {
            document.getElementById('connectionStatus').innerHTML = '未连接（需手动重连）';
        }
        renderTabBar();
        return;
    }

    if (tab.reconnectAttempts >= maxAttempts) {
        tab.reconnecting = false;
        tab.terminal.write('\r\n\x1b[31m自动重连失败：已达最大重试次数（' + maxAttempts + ' 次）。请手动刷新或新建会话。\x1b[0m\r\n');
        if (tab.id === activeTabId) {
            document.getElementById('connectionStatus').innerHTML = '重连失败';
        }
        return;
    }

    tab.reconnectAttempts++;
    tab.reconnecting = true;
    // 指数退避：2s, 3s, 4.5s, 6.75s, ~10s
    const delay = Math.round(baseDelay * Math.pow(1.5, tab.reconnectAttempts - 1));
    const secs = (delay / 1000).toFixed(1);

    tab.terminal.write('\r\n\x1b[33m[' + tab.reconnectAttempts + '/' + maxAttempts + '] ' + secs + ' 秒后尝试重连...\x1b[0m\r\n');
    if (tab.id === activeTabId) {
        document.getElementById('connectionStatus').innerHTML =
            '重连中 (' + tab.reconnectAttempts + '/' + maxAttempts + ')';
    }
    renderTabBar();

    tab.reconnectTimer = setTimeout(() => {
        tab.reconnectTimer = null;
        // 使用 tab 上保存的凭据重连
        connectSSHForTab(tab, tab.username, tab.password, true);
    }, delay);
}

// 建立文件管理用的独立 SSH 会话（用于对话框凭据提交，返回 Promise 结果）
// 注意：此函数仅用于凭据验证，验证后自动断开临时会话。
// 后端 /api/connect 不再往 HttpSession 写入 fileSessionId 单值，因此 fire-and-forget
// 断开临时会话不会影响其他标签页的文件会话。
async function connectFileSessionAsync(username, password) {
    const body = { host: currentHost };
    if (username) body.username = username;
    // 密码使用 RSA 加密后传输，与登录页流程一致
    if (password) {
        const enc = await encryptPassword(password);
        if (!enc) {
            return { success: false, authError: false, msg: '密码加密失败，请刷新页面重试' };
        }
        body.password = enc.encrypted;
        body.keyId = enc.keyId;
    }

    return fetch(contextPath + '/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
    .then(r => r.json())
    .then(data => {
        if (data.code === 200) {
            // 验证成功后断开临时会话（createTab 会创建独立的文件会话）
            const tempSessionId = data.sessionId;
            fetch(contextPath + '/api/disconnect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: tempSessionId })
            }).catch(() => {});
            return { success: true, authError: false, msg: data.msg };
        } else if (data.code === 401) {
            // 认证错误
            return { success: false, authError: true, msg: data.msg || 'SSH 认证失败，用户名或密码错误' };
        } else {
            // 其他错误
            return { success: false, authError: false, msg: data.msg || '建立文件会话失败' };
        }
    })
    .catch(err => {
        return { success: false, authError: false, msg: '建立文件会话失败: ' + err.message };
    });
}

// 获取终端初始工作目录（home），并让文件浏览器与之同步
function syncInitialCwd() {
    // 没有 fileSessionId 时不发起请求（后端已移除 HttpSession 回退）
    if (!fileSessionId) {
        currentPath = terminalCwd;
        loadFiles();
        if (followTerminalDir) startFollowTimer();
        return;
    }
    const params = new URLSearchParams();
    params.set('sessionId', fileSessionId);
    fetch(`${contextPath}/api/pwd?${params}`)
        .then(r => r.json())
        .then(d => {
            if (d.code === 200 && d.path) {
                terminalCwd = d.path;
                currentPath = terminalCwd;
                loadFiles();
                if (followTerminalDir) startFollowTimer();
            } else if (!fileSessionReconnecting && d.msg && d.msg.indexOf('SSH会话不存在') >= 0) {
                // 文件会话已失效（服务端重启等），自动重建
                fileSessionReconnecting = true;
                const tab = getActiveTab();
                if (tab) {
                    tab.fileSessionId = null;
                    fileSessionId = null;
                    connectFileSessionForTab(tab, tab.username, tab.password);
                } else {
                    fileSessionReconnecting = false;
                    currentPath = terminalCwd;
                    loadFiles();
                }
            } else {
                currentPath = terminalCwd;
                loadFiles();
                if (followTerminalDir) startFollowTimer();
            }
        })
        .catch(() => {
            currentPath = terminalCwd;
            loadFiles();
            if (followTerminalDir) startFollowTimer();
        });
}

// 累积终端输入，回车时尝试解析 cd 命令
function handleTerminalInput(data) {
    for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
            console.log('[follow] Enter detected, bufferReliable=', bufferReliable, 'buffer=', JSON.stringify(inputBuffer));
            // 记录命令日志：buffer 可靠时直接使用，不可靠时从终端显示行读取
            let loggedCommand = '';
            if (bufferReliable) {
                loggedCommand = inputBuffer.trim();
                tryParseCdCommand(inputBuffer);
            } else {
                // buffer 不可靠时（Tab 补全场景），直接从 xterm.js 显示行读取完整命令
                // 终端已经渲染了 shell 补全后的完整文本，比 keystroke 追踪更可靠
                loggedCommand = getCommandFromTerminalDisplay();
                tryParseCdCommandFromTerminalDisplay();
            }
            if (loggedCommand) {
                recordCommandLog(loggedCommand);
            }
            inputBuffer = '';
            bufferReliable = true;
            cdTabDetected = false;
        } else if (code === 3) {           // Ctrl+C
            inputBuffer = '';
            bufferReliable = true;
            cdTabDetected = false;
        } else if (code === 127 || code === 8) { // 退格
            inputBuffer = inputBuffer.slice(0, -1);
        } else if (code === 9) {           // Tab 补全，shell 可能插入补全字符，导致 buffer 与实际命令不一致
            console.log('[follow] Tab pressed, current buffer=', JSON.stringify(inputBuffer));
            bufferReliable = false;
        } else if (code === 27) {          // ESC（方向键等转义序列）
            bufferReliable = false;
        } else if (code >= 32) {           // 可打印字符
            inputBuffer += ch;
        }
    }
}

// 从 xterm.js 显示行读取完整命令（含 shell 补全文本），用于日志记录
function getCommandFromTerminalDisplay() {
    try {
        const buffer = terminal.buffer.active;
        // cursorY 在 Enter 处理时指向当前行（尚未换行）
        const lineNum = buffer.baseY + buffer.cursorY;
        const line = buffer.getLine(lineNum);
        if (!line) return '';
        let text = line.translateToString().trimEnd();
        if (!text) return '';
        // 去除 shell 提示符：常见格式 [user@host path]# / user@host:path$ / # / $
        // 提示符以 ]#、]$、#、$ 或 > 结尾后跟空格和命令
        const m = text.match(/^.*?(?:\]?\s*[#\$]|>)\s+(.+)$/);
        if (m) return m[1].trim();
        return text.trim();
    } catch (e) {
        return '';
    }
}

// 从 xterm.js 显示行读取完整命令（含 shell 补全文本），尝试解析 cd
function tryParseCdCommandFromTerminalDisplay() {
    try {
        const buffer = terminal.buffer.active;
        // cursorY 在 Enter 处理时指向当前行（尚未换行）
        const lineNum = buffer.baseY + buffer.cursorY;
        const line = buffer.getLine(lineNum);
        if (!line) return;
        let text = line.translateToString();
        console.log('[follow] terminal line read:', JSON.stringify(text));
        // 提取行末的 cd 命令（前面可能是 shell 提示符如 [root@host ~]#）
        const m = text.match(/cd(\s+(.*))?\s*$/);
        if (!m) return;
        let target = m[2] ? m[2].trim() : '';
        // 去掉外层引号
        if (target.length >= 2 &&
            ((target.startsWith('"') && target.endsWith('"')) ||
             (target.startsWith("'") && target.endsWith("'")))) {
            target = target.slice(1, -1);
        }
        console.log('[follow] cd from terminal display, target=', JSON.stringify(target), 'base=', terminalCwd);
        resolveCwd(target);
    } catch (e) {
        console.warn('[follow] failed to read terminal display:', e);
    }
}

// 解析一行命令是否为 cd，若是则同步文件浏览器路径
function tryParseCdCommand(line) {
    line = line.trim();
    if (!line) return;
    const m = line.match(/^\s*cd(?:\s+(.*))?$/);
    if (!m) return;
    let target = m[1] ? m[1].trim() : '';
    // 去掉外层引号
    if (target.length >= 2 &&
        ((target.startsWith('"') && target.endsWith('"')) ||
         (target.startsWith("'") && target.endsWith("'")))) {
        target = target.slice(1, -1);
    }
    console.log('[follow] cd detected, target=', JSON.stringify(target), 'base=', terminalCwd);
    resolveCwd(target);
}

// 调后端解析 cd 后的真实路径，并同步文件浏览器
function resolveCwd(target) {
    if (!fileSessionId) {
        console.warn('[follow] resolveCwd skipped: fileSessionId is null');
        return;
    }
    const payload = { sessionId: fileSessionId, base: terminalCwd, target: target };
    console.log('[follow] resolveCwd POST', payload);
    fetch(contextPath + '/api/resolve-cwd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
        .then(r => {
            console.log('[follow] resolveCwd response status:', r.status);
            return r.json();
        })
        .then(data => {
            console.log('[follow] resolveCwd response body:', data);
            if (data.code === 200 && data.path) {
                terminalCwd = data.path;
                // 状态栏位于终端面板，无论是否跟随终端，都应显示终端最新的工作目录
                document.getElementById('currentPath').textContent = '路径: ' + terminalCwd;
                if (followTerminalDir) {
                    currentPath = data.path;
                    loadFiles();
                }
            }
            // 解析失败则保持现状，不影响终端使用
        })
        .catch(err => {
            console.error('[follow] resolveCwd network error:', err);
        });
}

// 事件驱动方式：目录变化由 handleTerminalInput → tryParseCdCommand → resolveCwd 主动检测，
// 检测到 cd 命令后立即调用 loadFiles() 刷新，无需轮询。
function startFollowTimer() { /* 不再使用轮询 */ }
function stopFollowTimer() { /* 不再使用轮询 */ }

function loadFiles() {
    const fileList = document.getElementById('fileList');
    // 没有 fileSessionId 时不发起请求（后端已移除 HttpSession 回退）
    if (!fileSessionId) {
        fileList.innerHTML = '<div class="empty-state">未连接</div>';
        return;
    }
    fileList.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';
    fileList.querySelector('.loading').classList.add('show');

    const params = new URLSearchParams({ path: currentPath });
    params.set('sessionId', fileSessionId);
    fetch(`${contextPath}/api/files?${params}`)
        .then(r => r.json())
        .then(data => {
            fileList.innerHTML = '';
            if (data.code === 200) {
                fileSessionReconnecting = false;
                currentPath = data.path;
                updatePathInput(currentPath);
                // 状态栏位于终端面板，应显示终端当前工作目录，而非文件管理器路径
                document.getElementById('currentPath').textContent = '路径: ' + terminalCwd;
                renderBreadcrumb(data.path);
                renderFileList(data.files);
            } else {
                // 检测文件会话失效（服务端重启、会话超时等情况），自动重建文件会话
                if (!fileSessionReconnecting && data.msg && data.msg.indexOf('SSH会话不存在') >= 0) {
                    fileSessionReconnecting = true;
                    fileList.innerHTML = '<div class="loading"><div class="spinner"></div>正在重新建立连接...</div>';
                    const fileListLoading = fileList.querySelector('.loading');
                    if (fileListLoading) fileListLoading.classList.add('show');
                    const tab = getActiveTab();
                    if (tab) {
                        // 清除失效的文件会话ID，使用标签页保存的凭据重建
                        tab.fileSessionId = null;
                        fileSessionId = null;
                        connectFileSessionForTab(tab, tab.username, tab.password);
                    } else {
                        fileSessionReconnecting = false;
                        fileList.innerHTML = '<div class="error-message">连接已失效，请重新建立会话</div>';
                    }
                    return;
                }
                fileSessionReconnecting = false;
                fileList.innerHTML = '<div class="error-message">' + (data.msg || '加载失败') + '</div>';
            }
        })
        .catch(err => {
            fileSessionReconnecting = false;
            fileList.innerHTML = '<div class="error-message">加载失败: ' + err.message + '</div>';
        });
}

function renderBreadcrumb(path) {
    const parts = path.split('/').filter(p => p);
    let html = `<span class="breadcrumb-item" data-path="/">/</span>`;
    let current = '';
    parts.forEach((part, idx) => {
        current += '/' + part;
        // 第一个子项紧接根 "/"，不再重复分隔符
        if (idx > 0) {
            html += `<span class="breadcrumb-separator">/</span>`;
        }
        html += `<span class="breadcrumb-item" data-path="${current}">${part}</span>`;
    });
    document.getElementById('breadcrumb').innerHTML = html;
    document.querySelectorAll('.breadcrumb-item').forEach(item => {
        item.addEventListener('click', () => navigateToPath(item.dataset.path));
    });
}

function renderFileList(files) {
    const fileList = document.getElementById('fileList');
    let html = '';

    // 非根目录时，在列表顶部添加 ".." 返回上级目录
    if (currentPath && currentPath !== '/') {
        const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
        html += `<div class="file-item parent-dir" data-path="${parentPath}" data-type="dir">
            <span class="file-icon dir">\uD83D\uDCC1</span>
            <span class="file-name">..</span>
            <span class="file-info">上级目录</span>
        </div>`;
    }

    if (!files || files.length === 0) {
        fileList.innerHTML = html + '<div class="empty-state">此目录为空</div>';
        bindParentDirEvent(fileList);
        return;
    }
    html += files.map(f => `
        <div class="file-item" data-path="${f.path}" data-type="${f.isDir ? 'dir' : 'file'}">
            <span class="file-icon ${f.isDir ? 'dir' : getFileIconClass(f.ext)}">${getIcon(f)}</span>
            <span class="file-name">${f.name}</span>
            <span class="file-info">${f.isDir ? 'DIR' : formatSize(f.size)}</span>
        </div>
    `).join('');
    fileList.innerHTML = html;

    // 绑定 ".." 上级目录点击事件
    bindParentDirEvent(fileList);
    // 绑定文件/目录项事件
    bindFileItemEvents(fileList);
}

function bindParentDirEvent(fileList) {
    const parentItem = fileList.querySelector('.file-item.parent-dir');
    if (parentItem) {
        parentItem.addEventListener('dblclick', () => navigateToPath(parentItem.dataset.path));
        parentItem.addEventListener('click', (e) => {
            fileList.querySelectorAll('.file-item').forEach(i => i.classList.remove('selected'));
            parentItem.classList.add('selected');
        });
    }
}

function bindFileItemEvents(fileList) {
    fileList.querySelectorAll('.file-item:not(.parent-dir)').forEach(item => {
        // 双击：目录进入，可预览文件则预览
        item.addEventListener('dblclick', () => {
            if (item.dataset.type === 'dir') {
                navigateToPath(item.dataset.path);
            } else {
                const name = item.dataset.path.split('/').pop();
                const ext = name.split('.').pop().toLowerCase();
                const previewExts = ['txt', 'md', 'json', 'xml', 'yml', 'yaml', 'html', 'css', 'js', 'ts', 'java', 'py', 'sh', 'conf', 'log'];
                if (previewExts.includes(ext)) {
                    previewFile(item.dataset.path);
                }
            }
        });
        // 单击选中
        item.addEventListener('click', (e) => {
            fileList.querySelectorAll('.file-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
        });
        // 右键弹出下载菜单
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            fileList.querySelectorAll('.file-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            const isDir = item.dataset.type === 'dir';
            showContextMenu(e, item.dataset.path, isDir);
        });
    });
}

function getFileIconClass(ext) {
    const iconMap = {
        'txt': 'file-txt', 'md': 'file-txt', 'json': 'file-txt', 'xml': 'file-txt',
        'html': 'file-html', 'htm': 'file-html',
        'css': 'file-css', 'scss': 'file-css', 'sass': 'file-css',
        'js': 'file-js', 'jsx': 'file-js', 'ts': 'file-js', 'tsx': 'file-js',
        'java': 'file-java',
        'py': 'file-py',
        'zip': 'file-zip', 'tar': 'file-zip', 'gz': 'file-zip', 'rar': 'file-zip',
        'png': 'file-image', 'jpg': 'file-image', 'jpeg': 'file-image', 'gif': 'file-image',
    };
    return iconMap[ext] || 'file';
}

function getIcon(file) {
    if (file.isDir) return '\uD83D\uDCC1';
    const iconMap = {
        'txt': '\uD83D\uDCC4', 'md': '\uD83D\uDCDD', 'json': '\uD83D\uDCC4', 'xml': '\uD83D\uDCC4',
        'html': '\uD83C\uDF10', 'htm': '\uD83C\uDF10',
        'css': '\uD83C\uDFA8', 'scss': '\uD83C\uDFA8',
        'js': '\uD83D\uDCDC', 'jsx': '\u269B\uFE0F', 'ts': '\uD83D\uDCD8', 'tsx': '\u269B\uFE0F',
        'java': '\u2615',
        'py': '\uD83D\uDC0D',
        'zip': '\uD83D\uDCE6', 'tar': '\uD83D\uDCE6', 'gz': '\uD83D\uDCE6',
        'png': '\uD83D\uDDBC\uFE0F', 'jpg': '\uD83D\uDDBC\uFE0F', 'jpeg': '\uD83D\uDDBC\uFE0F', 'gif': '\uD83D\uDDBC\uFE0F',
    };
    return iconMap[file.ext] || '\uD83D\uDCC4';
}

function formatSize(size) {
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
    return (size / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function navigateToPath(path) {
    currentPath = path;
    loadFiles();
}

// ===== 路径显示/输入合并（点击切换） =====

// 进入编辑模式：隐藏面包屑，显示输入框
function enterPathEditMode() {
    const bar = document.getElementById('pathDisplayBar');
    const input = document.getElementById('pathInput');
    bar.classList.add('editing');
    input.value = currentPath;
    setTimeout(() => input.focus(), 0);
}

// 退出编辑模式：隐藏输入框，显示面包屑
function exitPathEditMode() {
    const bar = document.getElementById('pathDisplayBar');
    bar.classList.remove('editing');
    hideSuggestions();
}

function initPathInput() {
    const input = document.getElementById('pathInput');

    // 点击面包屑区域（非路径段）进入编辑模式
    document.getElementById('pathDisplayBar').addEventListener('click', (e) => {
        if (!e.target.closest('.breadcrumb-item') && !e.target.closest('.path-bar')) {
            enterPathEditMode();
        }
    });

    // 输入时防抖获取建议
    input.addEventListener('input', () => {
        clearTimeout(suggestDebounceTimer);
        suggestDebounceTimer = setTimeout(() => {
            suggestionIndex = -1;
            fetchSuggestions(input.value);
        }, 250);
    });

    // 键盘事件：Enter跳转、Escape取消、上下键选择、Tab补全
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const items = document.querySelectorAll('.path-suggestion-item');
            if (suggestionIndex >= 0 && suggestionIndex < items.length) {
                const selected = items[suggestionIndex];
                input.value = selected.dataset.path;
            }
            const path = input.value.trim();
            if (path) {
                hideSuggestions();
                navigateToPath(path);
                exitPathEditMode();
            }
        } else if (e.key === 'Escape') {
            input.value = currentPath;
            hideSuggestions();
            exitPathEditMode();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveSuggestion(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveSuggestion(-1);
        } else if (e.key === 'Tab') {
            e.preventDefault();
            const items = document.querySelectorAll('.path-suggestion-item');
            if (suggestionIndex >= 0 && suggestionIndex < items.length) {
                input.value = items[suggestionIndex].dataset.path;
            } else if (items.length > 0) {
                input.value = items[0].dataset.path;
            }
            hideSuggestions();
            clearTimeout(suggestDebounceTimer);
            suggestDebounceTimer = setTimeout(() => fetchSuggestions(input.value), 250);
        }
    });

    // 聚焦时显示建议
    input.addEventListener('focus', () => {
        fetchSuggestions(input.value);
    });

    // 失焦时退出编辑模式（延迟以允许点击建议项）
    input.addEventListener('blur', () => {
        setTimeout(() => {
            hideSuggestions();
            exitPathEditMode();
        }, 200);
    });
}

function moveSuggestion(dir) {
    const items = document.querySelectorAll('.path-suggestion-item');
    if (items.length === 0) return;
    // 移除旧的高亮
    items.forEach(i => i.classList.remove('active'));
    // 计算新索引（循环）
    suggestionIndex = (suggestionIndex + dir + items.length) % items.length;
    items[suggestionIndex].classList.add('active');
    // 滚动到可见区域
    items[suggestionIndex].scrollIntoView({ block: 'nearest' });
}

function fetchSuggestions(inputPath) {
    if (!inputPath || !fileSessionId) {
        hideSuggestions();
        return;
    }
    // 规范化路径
    if (!inputPath.startsWith('/')) {
        inputPath = '/' + inputPath;
    }
    const params = new URLSearchParams({ input: inputPath });
    params.set('sessionId', fileSessionId);

    fetch(`${contextPath}/api/suggest?${params}`)
        .then(r => r.json())
        .then(data => {
            if (data.code === 200) {
                showSuggestions(data.suggestions || []);
            } else {
                hideSuggestions();
            }
        })
        .catch(() => hideSuggestions());
}

function showSuggestions(suggestions) {
    const container = document.getElementById('pathSuggestions');
    if (!suggestions || suggestions.length === 0) {
        hideSuggestions();
        return;
    }
    container.innerHTML = suggestions.map(s =>
        `<div class="path-suggestion-item" data-path="${s.path}">
            <span class="path-suggestion-icon">\uD83D\uDCC1</span>
            <span>${s.name}</span>
        </div>`
    ).join('');
    container.classList.add('show');
    suggestionIndex = -1;

    // 根据下拉框在视口中的实际位置动态计算最大高度，使其尽量多显示且不超出视口底部
    // 内容少时高度自适应内容；内容多时受可用空间限制并滚动
    const rect = container.getBoundingClientRect();
    const availableHeight = window.innerHeight - rect.top - 8; // 留 8px 底部边距
    const maxHeight = Math.max(120, Math.min(availableHeight, 480)); // 限制在 120~480px
    container.style.maxHeight = maxHeight + 'px';

    // 点击建议项
    container.querySelectorAll('.path-suggestion-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const input = document.getElementById('pathInput');
            input.value = item.dataset.path;
            hideSuggestions();
            navigateToPath(item.dataset.path);
            exitPathEditMode();
        });
    });
}

function hideSuggestions() {
    document.getElementById('pathSuggestions').classList.remove('show');
    suggestionIndex = -1;
}

function updatePathInput(path) {
    const input = document.getElementById('pathInput');
    const bar = document.getElementById('pathDisplayBar');
    // 非编辑模式才更新输入框值
    if (input && !bar.classList.contains('editing')) {
        input.value = path;
    }
}

function showFileOptions(path) {
    const name = path.split('/').pop();
    const ext = name.split('.').pop().toLowerCase();
    const previewExts = ['txt', 'md', 'json', 'xml', 'yml', 'yaml', 'html', 'css', 'js', 'ts', 'java', 'py', 'sh', 'conf', 'log'];
    if (previewExts.includes(ext)) {
        previewFile(path);
    } else {
        downloadFile(path);
    }
}

function previewFile(path) {
    if (!fileSessionId) return;
    const name = path.split('/').pop();
    document.getElementById('previewTitle').textContent = '预览: ' + name;
    const content = document.getElementById('previewContent');
    content.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';
    content.querySelector('.loading').classList.add('show');
    document.getElementById('previewModal').classList.add('show');

    const params = new URLSearchParams({ path: path });
    params.set('sessionId', fileSessionId);
    fetch(`${contextPath}/api/preview?${params}`)
        .then(r => r.json())
        .then(data => {
            if (data.code === 200) {
                content.textContent = data.content;
            } else {
                content.innerHTML = '<div class="error-message">' + (data.msg || '加载失败') + '</div>';
            }
        })
        .catch(err => {
            content.innerHTML = '<div class="error-message">加载失败: ' + err.message + '</div>';
        });
}

function downloadFile(path, isDir) {
    if (!fileSessionId) return;
    const params = new URLSearchParams({ path: path });
    params.set('sessionId', fileSessionId);
    if (isDir) params.set('isDir', 'true');
    const url = `${contextPath}/api/download?${params}`;
    const a = document.createElement('a');
    a.href = url;
    const filename = path.split('/').pop() || 'download';
    a.download = isDir ? filename + '.tar.gz' : filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ===== 文件上传功能 =====
let uploadXhr = null; // 当前上传的 XMLHttpRequest，用于取消
// 批量上传冲突处理状态
let uploadConflictState = { overwriteAll: false, skipAll: false };

function initUploadEvents() {
    const uploadBtn = document.getElementById('uploadBtn');
    const hiddenInput = document.getElementById('hiddenFileInput');
    const uploadModal = document.getElementById('uploadModal');
    const closeUploadBtn = document.getElementById('closeUploadModal');
    const cancelUploadBtn = document.getElementById('cancelUpload');

    // 点击上传按钮 → 触发文件选择
    uploadBtn.addEventListener('click', () => {
        if (!fileSessionId) {
            alert('请先连接到主机');
            return;
        }
        hiddenInput.click();
    });

    // 文件选择后开始上传
    hiddenInput.addEventListener('change', () => {
        const files = hiddenInput.files;
        if (files && files.length > 0) {
            startUpload(files);
        }
        // 重置以便可以重复选择相同文件
        hiddenInput.value = '';
    });

    // 关闭上传对话框
    closeUploadBtn.addEventListener('click', hideUploadModal);
    cancelUploadBtn.addEventListener('click', cancelUpload);

    // 点击背景关闭（上传中不允许关闭）
    uploadModal.addEventListener('click', (e) => {
        if (e.target === e.currentTarget && !uploadXhr) {
            hideUploadModal();
        }
    });
}


function startUpload(files) {
    if (!fileSessionId) {
        alert('请先连接到主机');
        return;
    }

    // 重置冲突处理状态
    uploadConflictState = { overwriteAll: false, skipAll: false };

    const uploadModal = document.getElementById('uploadModal');
    const progressBar = document.getElementById('uploadProgressBar');
    const progressText = document.getElementById('uploadProgressText');
    const fileNameEl = document.getElementById('uploadFileName');
    const resultEl = document.getElementById('uploadResult');
    const footerEl = document.getElementById('uploadFooter');

    // 重置 UI
    progressBar.style.width = '0%';
    progressText.textContent = '准备上传...';
    resultEl.style.display = 'none';
    resultEl.className = 'upload-result';
    footerEl.style.display = 'flex';

    uploadModal.classList.add('show');

    // 保存文件列表用于回调
    const fileArray = Array.from(files);
    let idx = 0;

    function doNext() {
        if (idx >= fileArray.length) {
            progressText.textContent = fileArray.length + ' 个文件上传完成';
            progressBar.style.width = '100%';
            footerEl.style.display = 'none';
            uploadXhr = null;
            loadFiles();
            return;
        }
        uploadFileXhr(fileArray[idx], idx, fileArray.length, () => {
            idx++;
            doNext();
        });
    }

    doNext();
}

function uploadFileXhr(file, index, total, done, overwrite) {
    const progressBar = document.getElementById('uploadProgressBar');
    const progressText = document.getElementById('uploadProgressText');
    const fileNameEl = document.getElementById('uploadFileName');
    const resultEl = document.getElementById('uploadResult');
    const footerEl = document.getElementById('uploadFooter');

    // skipAll 模式下直接跳过当前文件
    if (uploadConflictState.skipAll && !overwrite) {
        const fileLabel = total > 1 ? `[${index + 1}/${total}] ` : '';
        fileNameEl.textContent = fileLabel + file.name;
        progressBar.style.width = '0%';
        progressText.textContent = '已跳过';
        resultEl.style.display = 'block';
        resultEl.className = 'upload-result error';
        resultEl.textContent = '⚠ 已跳过 (同名)';
        setTimeout(done, 300);
        return;
    }

    // overwrite 参数优先，其次取 overwriteAll 状态
    const shouldOverwrite = overwrite || uploadConflictState.overwriteAll;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('path', currentPath);
    formData.append('overwrite', shouldOverwrite ? 'true' : 'false');
    formData.append('sessionId', fileSessionId);

    const fileLabel = total > 1 ? `[${index + 1}/${total}] ` : '';
    fileNameEl.textContent = fileLabel + file.name;
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    resultEl.style.display = 'none';

    uploadXhr = new XMLHttpRequest();
    uploadXhr.open('POST', contextPath + '/api/upload', true);

    uploadXhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            progressBar.style.width = pct + '%';
            progressText.textContent = pct + '% (' + formatSize(e.loaded) + ' / ' + formatSize(e.total) + ')';
        }
    });

    uploadXhr.upload.addEventListener('load', () => {
        progressBar.style.width = '100%';
        progressText.textContent = '处理中...';
    });

    uploadXhr.addEventListener('load', () => {
        try {
            const resp = JSON.parse(uploadXhr.responseText);
            if (resp.code === 200) {
                resultEl.style.display = 'block';
                resultEl.className = 'upload-result success';
                resultEl.textContent = '✓ 上传成功';
                setTimeout(done, 600);
            } else if (resp.code === 409) {
                // 文件已存在，弹出覆盖确认对话框
                handleUploadConflict(file, index, total, done);
            } else {
                resultEl.style.display = 'block';
                resultEl.className = 'upload-result error';
                resultEl.textContent = '✗ ' + (resp.msg || '上传失败');
                setTimeout(done, 1500);
            }
        } catch (e) {
            resultEl.style.display = 'block';
            resultEl.className = 'upload-result error';
            resultEl.textContent = '✗ 响应解析失败';
            setTimeout(done, 1500);
        }
    });

    uploadXhr.addEventListener('error', () => {
        resultEl.style.display = 'block';
        resultEl.className = 'upload-result error';
        resultEl.textContent = '✗ 网络错误';
        footerEl.style.display = 'none';
        uploadXhr = null;
    });

    uploadXhr.addEventListener('abort', () => {
        progressText.textContent = '上传已取消';
        resultEl.style.display = 'block';
        resultEl.className = 'upload-result error';
        resultEl.textContent = '⚠ 上传已取消';
        footerEl.style.display = 'none';
        uploadXhr = null;
    });

    uploadXhr.send(formData);
}

// 文件上传冲突处理：显示覆盖确认对话框
function handleUploadConflict(file, index, total, done) {
    const resultEl = document.getElementById('uploadResult');
    const footerEl = document.getElementById('uploadFooter');
    resultEl.style.display = 'block';
    resultEl.className = 'upload-result error';
    resultEl.textContent = '⚠ 文件已存在: ' + file.name;

    const modal = document.getElementById('overwriteModal');
    const fileNameEl = document.getElementById('overwriteFileName');
    const allWrapper = document.getElementById('overwriteAllWrapper');
    const allCheckbox = document.getElementById('overwriteAllCheckbox');
    const confirmBtn = document.getElementById('confirmOverwriteBtn');
    const skipBtn = document.getElementById('skipOverwriteBtn');
    const cancelBtn = document.getElementById('closeOverwriteModal');

    fileNameEl.textContent = file.name;
    // 仅多文件批量上传时显示"应用到所有冲突"
    allWrapper.style.display = total > 1 ? 'flex' : 'none';
    allCheckbox.checked = false;
    modal.classList.add('show');

    function cleanup() {
        confirmBtn.removeEventListener('click', onConfirm);
        skipBtn.removeEventListener('click', onSkip);
        cancelBtn.removeEventListener('click', onCancel);
    }

    function onConfirm() {
        modal.classList.remove('show');
        if (allCheckbox.checked) {
            uploadConflictState.overwriteAll = true;
        }
        cleanup();
        // 以 overwrite=true 重新上传当前文件
        uploadFileXhr(file, index, total, done, true);
    }

    function onSkip() {
        modal.classList.remove('show');
        if (allCheckbox.checked) {
            uploadConflictState.skipAll = true;
        }
        cleanup();
        resultEl.textContent = '⚠ 已跳过: ' + file.name;
        setTimeout(done, 300);
    }

    function onCancel() {
        modal.classList.remove('show');
        cleanup();
        // 取消整个上传任务
        resultEl.textContent = '⚠ 上传已取消';
        footerEl.style.display = 'none';
        uploadXhr = null;
    }

    confirmBtn.addEventListener('click', onConfirm);
    skipBtn.addEventListener('click', onSkip);
    cancelBtn.addEventListener('click', onCancel);
}

function cancelUpload() {
    if (uploadXhr) {
        uploadXhr.abort();
        uploadXhr = null;
    }
}

function hideUploadModal() {
    if (uploadXhr) {
        return; // 上传中不允许关闭
    }
    document.getElementById('uploadModal').classList.remove('show');
}

// 下载文件夹前先检查大小，超过 1G 提示用户确认
let largeDirPending = { path: null };
function checkDirSizeBeforeDownload(path) {
    if (!fileSessionId) return;
    const params = new URLSearchParams({ path: path });
    params.set('sessionId', fileSessionId);
    fetch(`${contextPath}/api/calcSize?${params}`)
        .then(res => res.json())
        .then(data => {
            if (data.code === 200) {
                const sizeGB = data.size / (1024 * 1024 * 1024);
                if (data.size > 0 && sizeGB >= 1) {
                    // 超过 1G，弹出确认框
                    largeDirPending.path = path;
                    document.getElementById('largeDirMsg').innerHTML =
                        '文件夹 <b>' + path.split('/').pop() + '</b> 大小约为 <b style="color:#f0883e;">' +
                        data.sizeFormatted + '</b>，超过 1 GB，下载可能耗时较长。<br>确定要继续下载吗？';
                    document.getElementById('largeDirModal').classList.add('show');
                } else {
                    // 未超 1G 或无法获取大小，直接下载
                    downloadFile(path, true);
                }
            } else {
                // 查询失败，直接下载
                downloadFile(path, true);
            }
        })
        .catch(() => {
            // 网络错误，直接下载
            downloadFile(path, true);
        });
}

// ===== 自定义右键菜单 =====
let contextMenuTarget = { path: null, isDir: false };

function showContextMenu(e, path, isDir, emptySpace) {
    contextMenuTarget = { path, isDir, emptySpace };
    const menu = document.getElementById('contextMenu');
    const previewItem = document.getElementById('ctxPreview');
    const downloadItem = document.getElementById('ctxDownload');
    const propertiesItem = document.getElementById('ctxProperties');
    const uploadItem = document.getElementById('ctxUpload');
    const sepUpload = document.getElementById('ctxSepUpload');

    if (emptySpace) {
        // 空白区域右键：仅显示上传
        uploadItem.style.display = 'flex';
        sepUpload.style.display = 'none';
        downloadItem.style.display = 'none';
        propertiesItem.style.display = 'none';
        previewItem.style.display = 'none';
        document.getElementById('ctxSeparator').style.display = 'none';
    } else {
        // 文件/目录右键：显示下载、属性、预览，隐藏上传
        uploadItem.style.display = 'none';
        sepUpload.style.display = 'none';
        // 目录不显示预览选项
        if (isDir) {
            previewItem.style.display = 'none';
        } else {
            previewItem.style.display = 'flex';
            // 检查是否可预览
            const name = path.split('/').pop();
            const ext = name.split('.').pop().toLowerCase();
            const previewExts = ['txt', 'md', 'json', 'xml', 'yml', 'yaml', 'html', 'css', 'js', 'ts', 'java', 'py', 'sh', 'conf', 'log'];
            previewItem.style.display = previewExts.includes(ext) ? 'flex' : 'none';
        }
        downloadItem.style.display = 'flex';
        propertiesItem.style.display = 'flex';
        document.getElementById('ctxSeparator').style.display = '';
    }

    // 定位菜单，确保不超出屏幕
    let x = e.clientX;
    let y = e.clientY;
    menu.style.display = 'block';
    menu.classList.add('show');

    // 用 requestAnimationFrame 等待渲染完成后再计算尺寸
    requestAnimationFrame(() => {
        const menuW = menu.offsetWidth;
        const menuH = menu.offsetHeight;
        if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 5;
        if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 5;
        if (x < 0) x = 5;
        if (y < 0) y = 5;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    });
}

function hideContextMenu() {
    const menu = document.getElementById('contextMenu');
    menu.classList.remove('show');
    menu.style.display = 'none';
    contextMenuTarget = { path: null, isDir: false };
}

// 获取并展示文件/目录属性
function showFileProperties(path) {
    if (!fileSessionId) return;
    const modal = document.getElementById('propertiesModal');
    const content = document.getElementById('propertiesContent');
    content.innerHTML = '<div style="text-align: center; padding: 20px;"><div class="spinner"></div><p style="margin-top: 10px; color: var(--text-muted);">加载中...</p></div>';
    modal.classList.add('show');

    const params = new URLSearchParams({ path: path });
    params.set('sessionId', fileSessionId);
    fetch(`${contextPath}/api/stat?${params}`)
        .then(r => r.json())
        .then(data => {
            if (data.code === 200 && data.data) {
                const d = data.data;
                const rows = [
                    ['名称', escapeHtml(d.name || '-')],
                    ['路径', escapeHtml(d.path || '-')],
                    ['类型', escapeHtml(d.type || '-')],
                    ['权限', escapeHtml(d.permissions || '-') + ' (' + escapeHtml(d.permissionsOctal || '000') + ')'],
                    ['大小', escapeHtml(d.sizeFormatted || '-') + ' (' + (d.size || 0).toLocaleString() + ' 字节)'],
                    ['所有者', escapeHtml(d.owner || '-')],
                    ['用户组', escapeHtml(d.group || '-')],
                    ['inode', escapeHtml(String(d.inode || '-'))],
                    ['硬链接数', escapeHtml(String(d.links || '-'))],
                    ['块大小', escapeHtml(d.blockSize ? d.blockSize.toLocaleString() + ' 字节' : '-')],
                    ['占用块', escapeHtml(d.blocks ? d.blocks.toLocaleString() : '-')],
                    ['修改时间', escapeHtml(d.modifyTime || '-')],
                    ['访问时间', escapeHtml(d.accessTime || '-')],
                    ['变更时间', escapeHtml(d.changeTime || '-')]
                ];
                content.innerHTML = '<table class="props-table">' +
                    rows.map(r => '<tr><td class="prop-label">' + r[0] + ':</td><td class="prop-value">' + r[1] + '</td></tr>').join('') +
                    '</table>';
            } else {
                content.innerHTML = '<div class="error-message">' + escapeHtml(data.msg || '获取属性失败') + '</div>';
            }
        })
        .catch(err => {
            content.innerHTML = '<div class="error-message">获取属性失败: ' + escapeHtml(err.message) + '</div>';
        });
}

function hidePropertiesModal() {
    document.getElementById('propertiesModal').classList.remove('show');
}

// ===== 终端右键菜单（复制） =====
let terminalSelection = '';

function showTerminalContextMenu(e) {
    const menu = document.getElementById('terminalContextMenu');
    menu.style.display = 'block';
    menu.classList.add('show');

    let x = e.clientX;
    let y = e.clientY;
    requestAnimationFrame(() => {
        const menuW = menu.offsetWidth;
        const menuH = menu.offsetHeight;
        if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 5;
        if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 5;
        if (x < 0) x = 5;
        if (y < 0) y = 5;
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    });
}

function hideTerminalContextMenu() {
    const menu = document.getElementById('terminalContextMenu');
    menu.classList.remove('show');
    menu.style.display = 'none';
    terminalSelection = '';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===== 文件面板拖拽调整宽度 =====
function initResizer() {
    const resizer = document.getElementById('resizer');
    const panel = document.getElementById('filePanel');
    const terminalPanel = document.querySelector('.terminal-panel');
    let dragging = false;
    let startX = 0, startWidth = 0, pendingX = 0;
    let rafId = null;

    resizer.addEventListener('mousedown', (e) => {
        if (panel.classList.contains('collapsed')) return;
        dragging = true;
        startX = e.clientX;
        startWidth = panel.offsetWidth;
        pendingX = e.clientX;
        // 冻结终端布局，阻止 xterm.js 随容器宽度变化而重新渲染
        terminalPanel.style.contain = 'layout style';
        terminalPanel.style.willChange = 'width';
        panel.style.transition = 'none';
        panel.style.willChange = 'width';
        resizer.classList.add('active');
        document.body.classList.add('resizing');
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        pendingX = e.clientX;
        if (!rafId) {
            rafId = requestAnimationFrame(() => {
                const delta = pendingX - startX;
                const maxWidth = window.innerWidth - 200;
                const newWidth = Math.max(180, Math.min(startWidth + delta, maxWidth));
                panel.style.width = newWidth + 'px';
                rafId = null;
            });
        }
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        // 恢复终端布局，解除隔离后触发一次性尺寸适配
        terminalPanel.style.contain = '';
        terminalPanel.style.willChange = '';
        panel.style.transition = '';
        panel.style.willChange = '';
        resizer.classList.remove('active');
        document.body.classList.remove('resizing');
        clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = setTimeout(safeFit, 50);
    });
}

// ===== 命令日志功能 =====
// 记录用户在终端执行的每条命令，按标签页独立存储，支持查看、复制、清空

// 记录一条命令到当前活跃标签页的日志
function recordCommandLog(command) {
    const at = getActiveTab();
    if (!at) return;
    if (!at.commandLog) at.commandLog = [];
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    at.commandLog.push({ time: time, command: command });
}

// 显示命令日志弹窗（展示当前活跃标签页的日志）
function showCommandLog() {
    const at = getActiveTab();
    const titleEl = document.getElementById('logModalTitle');
    const content = document.getElementById('logContent');
    if (at) {
        titleEl.textContent = '命令日志 - ' + at.label;
    } else {
        titleEl.textContent = '命令日志';
    }
    if (!at || !at.commandLog || at.commandLog.length === 0) {
        content.innerHTML = '<div class="log-empty">暂无命令记录</div>';
    } else {
        content.innerHTML = at.commandLog.map(entry =>
            '<div class="log-entry">' +
            '<span class="log-time">' + escapeHtml(entry.time) + '</span>' +
            '<span class="log-cmd">' + escapeHtml(entry.command) + '</span>' +
            '</div>'
        ).join('');
        // 滚动到底部显示最新记录
        content.scrollTop = content.scrollHeight;
    }
    document.getElementById('logModal').classList.add('show');
}

// 清空当前活跃标签页的命令日志
function clearCommandLog() {
    const at = getActiveTab();
    if (!at) return;
    at.commandLog = [];
    showCommandLog();
}

// 复制当前活跃标签页的全部命令日志到剪切板
async function copyCommandLog() {
    const at = getActiveTab();
    if (!at || !at.commandLog || at.commandLog.length === 0) {
        return;
    }
    const text = at.commandLog.map(e => '[' + e.time + '] ' + e.command).join('\n');
    let ok = false;
    try {
        await navigator.clipboard.writeText(text);
        ok = true;
    } catch (e) {
        // 降级方案：非 HTTPS 或浏览器不支持 clipboard API
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            ok = document.execCommand('copy');
        } catch (err) {
            ok = false;
        }
        document.body.removeChild(textarea);
    }
    // 视觉反馈：按钮短暂显示"已复制"
    const btn = document.getElementById('copyLogBtn');
    if (ok) {
        const orig = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = orig; }, 1200);
    }
}

// ===== 终端日志功能 =====
// 导出当前活跃标签页终端界面显示的全部内容（含滚动回溯与可见区），支持查看与下载

// 读取当前活跃标签页终端缓冲区的全部内容
function getTerminalLogText() {
    const at = getActiveTab();
    if (!at || !at.terminal) return '';
    try {
        const buffer = at.terminal.buffer.active;
        const lines = [];
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            // translateToString(true) 去除行尾多余空白
            lines.push(line ? line.translateToString(true) : '');
        }
        // 去除末尾连续空行
        while (lines.length > 0 && lines[lines.length - 1] === '') {
            lines.pop();
        }
        return lines.join('\n');
    } catch (e) {
        return '';
    }
}

// 显示终端日志弹窗（展示当前活跃标签页的终端内容）
function showTerminalLog() {
    const at = getActiveTab();
    const titleEl = document.getElementById('terminalLogModalTitle');
    const content = document.getElementById('terminalLogContent');
    if (at) {
        titleEl.textContent = '终端日志 - ' + at.label;
    } else {
        titleEl.textContent = '终端日志';
    }
    const text = getTerminalLogText();
    if (!text) {
        content.innerHTML = '<div class="log-empty">暂无终端内容</div>';
    } else {
        // textContent 自动转义 HTML，配合 white-space: pre-wrap 保留换行
        content.textContent = text;
        content.scrollTop = 0;
    }
    document.getElementById('terminalLogModal').classList.add('show');
}

// 下载当前活跃标签页的终端日志为文本文件
function downloadTerminalLog() {
    const text = getTerminalLogText();
    if (!text) return;
    const at = getActiveTab();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
        '_' + pad(now.getHours()) + '-' + pad(now.getMinutes()) + '-' + pad(now.getSeconds());
    // 文件名中的非法字符替换为下划线
    const label = at ? at.label.replace(/[\\/:*?"<>|]/g, '_') : 'terminal';
    const filename = 'terminal-log_' + label + '_' + ts + '.txt';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    // 视觉反馈：按钮短暂显示"已下载"
    const btn = document.getElementById('downloadTerminalLogBtn');
    const orig = btn.textContent;
    btn.textContent = '已下载';
    setTimeout(() => { btn.textContent = orig; }, 1200);
}
