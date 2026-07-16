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
let lastSentCols = 0;            // 上次已发送的列数（避免重复发送）
let lastSentRows = 0;            // 上次已发送的行数（避免重复发送）
let hostsInfo = [];              // 主机信息列表
let credentialsCache = {};       // 凭据缓存
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
    updateEmptyState();
});

// 为标签页创建终端 DOM 和 xterm.js 实例
function createTerminalForTab(tabId) {
    const container = document.getElementById('terminalContainer');
    const el = document.createElement('div');
    el.id = 'terminal-' + tabId;
    el.className = 'tab-terminal';
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
function createTab(host, username, password, rememberCredentials) {
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
        // 命令日志（记录用户在终端输入的每条命令）
        commandLog: []
    };

    tabs.push(tab);
    renderTabBar();
    updateEmptyState();
    switchTab(tabId);
    term.write('\x1b[33mWebSSH - 请选择主机连接\x1b[0m\r\n');

    // 自动连接终端
    connectSSHForTab(tab, username, password);
    // 为新标签页创建独立的文件会话
    connectFileSessionForTab(tab, username, password);

    return tab;
}

// 切换标签页
function switchTab(tabId) {
    const oldTab = getActiveTab();
    const newTab = tabs.find(t => t.id === tabId);
    if (!newTab || newTab.id === activeTabId) return;

    // 保存旧标签页的文件管理器状态
    saveGlobalsToTab(oldTab);

    // 隐藏旧终端
    if (oldTab && oldTab.element) {
        oldTab.element.classList.remove('active');
    }

    // 显示新终端
    activeTabId = tabId;
    newTab.element.classList.add('active');
    syncGlobalsToTab(newTab);

    // 适配终端尺寸
    if (newTab.fitAddon && newTab.terminal) {
        lastSentCols = 0;
        lastSentRows = 0;
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
}

// 刷新文件管理器 UI 以匹配当前标签页状态
function refreshFilePanelForTab(tab) {
    // 更新跟随终端复选框
    const followCheckbox = document.getElementById('followTerminalDir');
    followCheckbox.checked = tab.followTerminalDir;

    // 更新路径显示（状态栏位于终端面板，应显示终端当前工作目录，而非文件管理器路径）
    document.getElementById('currentPath').textContent = '路径: ' + (tab.terminalCwd || '/');

    if (tab.fileSessionId) {
        // 已有文件会话，直接刷新文件列表和路径栏
        renderBreadcrumb(tab.currentPath || '/');
        updatePathInput(tab.currentPath || '/');
        loadFiles();
    } else if (tab.fileSessionConnected === false) {
        // 文件会话尚未建立
        document.getElementById('fileList').innerHTML =
            '<div class="empty-state">正在连接文件会话...</div>';
        renderBreadcrumb(tab.currentPath || '/');
        updatePathInput(tab.currentPath || '/');
    } else {
        document.getElementById('fileList').innerHTML =
            '<div class="empty-state">未连接</div>';
    }
}

// 关闭标签页
function closeTab(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

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
        }
    }

    renderTabBar();
    updateEmptyState();
}

// 复制会话
function duplicateSession(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    createTab(tab.host, tab.username, tab.password, tab.rememberCredentials);
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
        return `<div class="tab-item${activeClass}" data-tab-id="${t.id}" title="${t.label} (${t.host})" draggable="true">
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
                closeTab(item.dataset.tabId);
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
            closeTab(btn.dataset.tabClose);
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
    document.getElementById('ctxTabDuplicate').addEventListener('click', () => {
        if (ctxTabTargetId) duplicateSession(ctxTabTargetId);
        hideTabContextMenu();
    });
    document.getElementById('ctxTabClose').addEventListener('click', () => {
        if (ctxTabTargetId) closeTab(ctxTabTargetId);
        hideTabContextMenu();
    });
    document.getElementById('ctxTabCloseOthers').addEventListener('click', () => {
        if (ctxTabTargetId) {
            const toClose = tabs.filter(t => t.id !== ctxTabTargetId);
            toClose.forEach(t => closeTab(t.id));
        }
        hideTabContextMenu();
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
            if (hostsInfo.length > 0 && tabs.length === 0) {
                const host = hostsInfo[0];
                currentHost = host.name;
                selector.selectedIndex = 0;
                if (host.needCredentials) {
                    showCredentialDialog();
                } else {
                    createTab(host.name, '', '');
                }
            }
        });
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
    if (!terminal || !fitAddon) return;
    try {
        fitAddon.fit();
    } catch (e) {
        // 容器未渲染好时 fit 可能抛异常，忽略即可
        return;
    }
    sendTerminalSize();
}

// 将终端行列数发送给后端，后端据此调用 setPtySize 调整 SSH 伪终端
function sendTerminalSize() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const cols = terminal.cols;
    const rows = terminal.rows;
    // 尺寸未变化则不重复发送
    if (cols === lastSentCols && rows === lastSentRows) return;
    lastSentCols = cols;
    lastSentRows = rows;
    socket.send(JSON.stringify({ type: 'resize', cols: cols, rows: rows }));
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
    // 输入框失焦且值变化时：更新 currentHost、清空凭据、刷新表单可见性
    hostInput.onchange = () => {
        currentHost = hostInput.value.trim();
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
    if (curHostInfo && !curHostInfo.needCredentials) {
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
            // 认证成功：缓存凭据、关闭对话框、创建标签页
            if (remember) {
                credentialsCache[currentHost] = { username, password };
            }
            hideCredentialDialog();
            createTab(currentHost, username, password, remember);
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

    document.getElementById('refreshBtn').addEventListener('click', () => {
        const at = getActiveTab();
        if (!at) return;
        const hostInfo = hostsInfo.find(h => h.name === at.host);
        // 自定义主机（不在配置中）始终需要凭据
        const needCredentials = hostInfo ? hostInfo.needCredentials : true;

        // 检查是否有缓存的凭据
        const cachedCreds = getCachedCredentials(at.host);
        if (needCredentials && !cachedCreds) {
            currentHost = at.host;
            showCredentialDialog();
        } else if (needCredentials && cachedCreds) {
            // 有缓存凭据，重新连接当前标签页
            if (at.socket) { try { at.socket.close(); } catch (e) {} }
            at.connected = false;
            connectSSHForTab(at, cachedCreds.username, cachedCreds.password);
        } else {
            if (at.socket) { try { at.socket.close(); } catch (e) {} }
            at.connected = false;
            connectSSHForTab(at, at.username || '', at.password || '');
        }
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
    document.getElementById('closeCredential').addEventListener('click', hideCredentialDialog);
    document.getElementById('cancelCredential').addEventListener('click', hideCredentialDialog);
    document.getElementById('submitCredential').addEventListener('click', submitCredentials);
    
    // 主机组合框：输入过滤、聚焦展开、键盘导航（↑↓/Enter/Esc）、点击选择
    const hostInput = document.getElementById('credentialHost');
    const hostDropdown = document.getElementById('hostDropdown');

    // 输入时实时过滤下拉项并展开
    hostInput.addEventListener('input', () => {
        populateHostDropdown(hostInput.value.trim());
        showHostDropdown();
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
        if (tab.id === activeTabId) {
            // switchTab 发生在 socket 创建之前，全局 socket 此前还是旧值或 null，
            // 这里同步为当前 tab 的实例，确保 sendTerminalSize 走当前连接
            socket = tab.socket;
            terminal = tab.terminal;
            fitAddon = tab.fitAddon;
            lastSentCols = 0;
            lastSentRows = 0;
            // 立即同步发送当前尺寸（已在握手前 fit 过，cols/rows 可用）
            sendTerminalSize();
            // 兜底：下一帧再 fit 一次，覆盖容器尺寸尚未稳定的情况
            requestAnimationFrame(() => safeFit());
        }
    };
    tab.socket.onmessage = (event) => {
        tab.terminal.write(event.data);
    };
    tab.socket.onclose = (event) => {
        // 忽略已被新连接替换的旧 socket 的关闭事件
        if (event.target !== tab.socket) return;
        tab.connected = false;
        if (tab.id === activeTabId) {
            document.getElementById('connectionStatus').innerHTML = '未连接';
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
