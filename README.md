

<h1 align="center">WebSSH</h1>

**基于Spring Boot的Web SSH终端解决方案**

- **双模部署**：支持作为`Spring Boot Starter`依赖嵌入现有项目，亦可独立部署运行。
- **极简接入**：引入依赖并简单配置，即可快速启用。
- **零客户端**：通过浏览器直接操作`Linux`服务器，无需安装任何额外软件。

![login](data/md/login.png)

# 1. 功能特性

- **Web 终端**：基于 `xterm.js` + `WebSocket`，完整终端体验（`vim`、`top`等全屏程序正常显示）
- **多标签页**：同时连接多台主机，标签页拖拽排序，独立会话互不影响
- **分屏终端**：拖拽会话标签到终端区触发分屏，支持水平/垂直方向与嵌套（最多 4 面板），分隔条可拖拽调整比例；切换标签或新建会话不影响
- **文件管理**：`SFTP` 浏览目录、上传/下载文件与目录（目录自动`tar`打包）、文本预览、查看属性
- **主题切换**：`Dark`/`Light`双主题，终端、文件管理器、弹窗等全局联动（顶部导航栏固定暗色）
- **安全传输**：登录密码经 RSA 加密传输，私钥一次性使用，用后即焚
- **防暴力破解**：基于`IP`的登录失败计数与自动锁定
- **风险命令拦截**：正则匹配危险命令（如 `rm -rf /`），命中则拒绝执行
- **主机密钥校验**：支持严格校验（防中间人攻击）与免校验两种模式
- **认证方式**：密码认证与私钥认证（可选私钥口令）
- **终端自适应**：`PTY`尺寸随浏览器窗口实时同步，`vim`等程序启动即正确填充
- **系统监控**：实时显示远程主机 `CPU`/`RAM`/`Disk`/`Load`/`Net` 指标，阈值告警（≥75% 警告、≥90% 危险），点击指标可查看详情

![webssh](data/md/webssh.gif)

# 2. 技术栈

| 层面       | 技术                           |
| ---------- | ------------------------------ |
| 后端       | Spring Boot 2.3.x ~ 4.0.x（多版本适配）|
| JDK        | Java 8+（2.x starter）/ Java 17+（3.x/4.x starter）|
| SSH 客户端 | JSch（com.github.mwiede:jsch） |
| 通信       | WebSocket                      |
| 前端终端   | xterm.js 5.5.0                 |
| 构建       | Maven 多模块                   |

### 多版本适配方案

采用 **共享 core + 多 starter** 架构，一套代码支持 Spring Boot 2.3 ~ 4.0 全系列：

```
Spring Boot 版本    │ 推荐使用                           │ 编译基线
────────────────────┼──────────────────────────────────┼──────────────────────────
2.3 ~ 2.7           │ yyj-webssh-spring-boot2-starter  │ SB 2.3.12 + Java 8
3.0 ~ 3.5           │ yyj-webssh-spring-boot3-starter  │ SB 3.0.12 + Java 17
4.0                 │ yyj-webssh-spring-boot3-starter  │ SB 3.0.12 + Java 17（前向兼容）
────────────────────┴──────────────────────────────────┴──────────────────────────
共享核心           │ yyj-webssh-core                    │ SB 2.3.12 + Java 8（servlet-free）
```

- **2.x starter**：使用 `javax.servlet` + `spring.factories`，Java 8 字节码
- **3.x/4.x starter**：使用 `jakarta.servlet` + `AutoConfiguration.imports`，Java 17 字节码
- **core 模块**：servlet-free，所有版本通用的 SSH/PTY/RSA 业务逻辑

> **版本号策略**：core 的版本号独立于 starter 演进。core 1.0.0 是共享核心的首发版本，被 starter-2x 2.0.0 与 starter-3x 3.0.0 同时依赖，并非"旧版"。starter 版本号首位对应所适配的 Spring Boot 大版本（2.x / 3.x）。

# 3. 项目结构

```
webssh/                                                # 父 POM (java=21, sb=4.0.6)
├── pom.xml                                            # 父 POM（依赖管理）
├── yyj-webssh-core/                                   # 共享核心（servlet-free, java=8, sb=2.3.12）
│   └── src/main/java/com/webssh/
│       ├── config/WebSshProperties.java              # 配置属性类
│       ├── ssh/                                      # SSH/PTY/本地文件服务（核心业务）
│       ├── util/RsaUtil.java                         # RSA 工具（servlet-free 版本）
│       └── security/LoginAttemptService.java          # 登录限制服务（IP 由调用方传入）
│
├── yyj-webssh-spring-boot3-starter/                # spring-boot3-starter（SB 3.0~4.0, java=17, sb=3.0.12）
│   └── src/main/
│       ├── java/com/webssh/
│       │   ├── config/WebSshAutoConfiguration.java   # 自动配置类
│       │   ├── controller/                           # 认证、文件管理、页面控制器
│       │   ├── security/                             # 认证拦截器、ClientIpExtractor
│       │   ├── util/RsaSessionHelper.java            # RSA 助手（jakarta.servlet 版本）
│       │   └── websocket/                            # WebSocket 配置与处理器
│       └── resources/META-INF/
│           ├── resources/webssh/                     # 前端页面（HTML/CSS/JS/xterm）
│           └── spring/                               # AutoConfiguration.imports
│
├── yyj-webssh-spring-boot2-starter/                # spring-boot2-starter（SB 2.3~2.7, java=8, sb=2.3.12）
│   └── src/main/
│       ├── java/com/webssh/                          # 与默认 starter 同名同结构（import javax.servlet）
│       └── resources/META-INF/
│           ├── resources/webssh/                     # 前端页面（同上）
│           └── spring.factories                      # SB 2.x 自动装配入口
│
└── webssh-app/                                       # 示例应用（SB 4.0.6 + Java 21，可直接运行）
    └── src/main/
        ├── java/com/yyj/                              # 启动类（启动后自动打开浏览器）
        └── resources/
            ├── application.yml                        # 端口、上传限制等
            └── application-webssh.yml                 # WebSSH 配置
```

# 4. 快速开始

## 4.1 构建项目

```bash
# 在项目根目录执行（需 Java 21 + Maven）
mvn clean install -DskipTests
```

构建产物：
- `yyj-webssh-core/target/yyj-webssh-core-1.0.0.jar` — 共享核心制品
- `yyj-webssh-spring-boot3-starter/target/yyj-webssh-spring-boot3-starter-3.0.0.jar` — spring-boot3-starter 制品（SB 3.x/4.x）
- `yyj-webssh-spring-boot2-starter/target/yyj-webssh-spring-boot2-starter-2.0.0.jar` — spring-boot2-starter 制品（SB 2.x）
- `webssh-app/target/webssh-app.jar` — 可直接运行的示例应用（SB 4.0.6）

## 4.2 运行示例应用

```bash
java -jar webssh-app/target/webssh-app.jar
```

启动后自动打开浏览器访问登录页，也可手动访问 `http://localhost:8080/webssh/login.html`。

## 4.3 接入已有 Spring Boot 项目

**步骤一：根据 Spring Boot 版本选择对应的 starter**

| 你的 Spring Boot 版本 | 依赖 artifactId              | JDK 要求 |
|------------------------|------------------------------|----------|
| 2.3.x ~ 2.7.x          | `yyj-webssh-spring-boot2-starter` | Java 8+  |
| 3.0.x ~ 3.5.x          | `yyj-webssh-spring-boot3-starter` | Java 17+ |
| 4.0.x                  | `yyj-webssh-spring-boot3-starter` | Java 17+ |

> **判断依据**：SB 2.x 使用 `javax.servlet`，SB 3.x/4.x 使用 `jakarta.servlet`，命名空间不同需选用对应 starter。

**步骤二：添加 Maven 依赖**

> **必读**：`yyj-webssh-core` 是 WebSSH 的共享核心模块（包含 SSH/PTY/本地文件/RSA/登录限制等业务逻辑），与 starter 是**两个独立版本号**的制品（core 1.0.0、starter-2x 2.0.0、starter-3x 3.0.0）。引入 starter 时**必须同时引入 core**，二者缺一不可。

以 Spring Boot 3.x/4.x 项目为例：

```xml
<dependencyManagement>
    <dependencies>
        <!-- WebSSH 共享核心（必选） -->
        <dependency>
            <groupId>io.github.youngyajun</groupId>
            <artifactId>yyj-webssh-core</artifactId>
            <version>1.0.0</version>
        </dependency>
        <!-- WebSSH Spring Boot 3.x/4.x Starter（必选） -->
        <dependency>
            <groupId>io.github.youngyajun</groupId>
            <artifactId>yyj-webssh-spring-boot3-starter</artifactId>
            <version>3.0.0</version>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <!-- WebSSH 共享核心（必选） -->
    <dependency>
        <groupId>io.github.youngyajun</groupId>
        <artifactId>yyj-webssh-core</artifactId>
    </dependency>
    <!-- WebSSH Spring Boot 3.x/4.x Starter（必选） -->
    <dependency>
        <groupId>io.github.youngyajun</groupId>
        <artifactId>yyj-webssh-spring-boot3-starter</artifactId>
    </dependency>
</dependencies>
```

若是 Spring Boot 2.x 项目，将 starter 的 artifactId 替换为 `yyj-webssh-spring-boot2-starter`，版本号改为 `2.0.0`，core 保持不变：

```xml
<dependencyManagement>
    <dependencies>
        <!-- WebSSH 共享核心（必选） -->
        <dependency>
            <groupId>io.github.youngyajun</groupId>
            <artifactId>yyj-webssh-core</artifactId>
            <version>1.0.0</version>
        </dependency>
        <!-- WebSSH Spring Boot 2.x Starter（必选） -->
        <dependency>
            <groupId>io.github.youngyajun</groupId>
            <artifactId>yyj-webssh-spring-boot2-starter</artifactId>
            <version>2.0.0</version>
        </dependency>
    </dependencies>
</dependencyManagement>

<dependencies>
    <!-- WebSSH 共享核心（必选） -->
    <dependency>
        <groupId>io.github.youngyajun</groupId>
        <artifactId>yyj-webssh-core</artifactId>
    </dependency>
    <!-- WebSSH Spring Boot 2.x Starter（必选） -->
    <dependency>
        <groupId>io.github.youngyajun</groupId>
        <artifactId>yyj-webssh-spring-boot2-starter</artifactId>
    </dependency>
</dependencies>
```

> **依赖说明**：
> - `yyj-webssh-core` 与 `yyj-webssh-spring-boot*-starter` 必须同时引入，二者缺一不可
> - Starter 会自动传递 `spring-boot-starter-web`、`spring-boot-starter-websocket`，无需重复声明
> - `spring-boot-configuration-processor` 已在 starter 中标记为 `optional`，不会传递到最终项目

**步骤三：配置 `application-webssh.yml`**

```yaml
# WebSSH 配置
# ============================================================================
# 文件上传/下载大小限制说明
# ----------------------------------------------------------------------------
# 1. 上传（POST /webssh/api/upload）
#    - 受 Spring Boot 全局 multipart 配置约束，配置项位于 application.yml：
#        spring.servlet.multipart.max-file-size        单文件最大大小（默认 1MB）
#        spring.servlet.multipart.max-request-size     整个请求最大大小（默认 10MB）
#    - 超过限制会抛 MaxUploadSizeExceededException，前端收到 500 错误
#    - 若使用反向代理（如 Nginx），还需同步调整 client_max_body_size
#      以及 Tomcat 的 server.tomcat.max-swallow-size / max-http-form-post-size
#
# 2. 下载（GET /webssh/api/download）
#    - 代码层面无大小限制，采用 SFTP/tar 流式传输（4KB 缓冲区）
#    - 实际上限受 HTTP 超时、代理超时（proxy_read_timeout）等网络层约束
#
# 3. 文件预览（GET /webssh/api/preview）
#    - 硬编码 2MB 限制（WebSshFileController 中 maxSize = 2 * 1024 * 1024）
#    - 超过会提示“文件过大，不支持预览，请直接下载”，如需调整需改源码
# ============================================================================
webssh:
  # 是否启用（设为 false 则完全关闭 WebSSH）
  enabled: true
  # WebSSH 界面访问路径前缀
  context-path: /webssh
  # SSH 连接超时（毫秒）
  timeout: 10000
  # 终端类型
  terminal-type: xterm-256color
  # 字符编码
  charset: UTF-8
  # 主机密钥校验：yes=严格校验（推荐生产环境），no=不校验（默认）
  host-key-verification: no
  # known_hosts 路径（host-key-verification=yes 时使用）
  # known-hosts: ~/.ssh/known_hosts
  # ============================================================================
  # WebSSH 管理界面登录账号配置（单账号与多账号可共存，用户名冲突时以多账号为准）
  # ----------------------------------------------------------------------------
  # 【密码强度规则】长度 8~19 位（>=8 且 <20），必须同时包含：
  #   - 大写字母 A-Z
  #   - 小写字母 a-z
  #   - 数字 0-9
  # 不符合规则的账号视为无效，启动时仅告警并跳过（不影响启动），但无法用于登录。
  # 例如 "Abc12345" 合规；"webssh"（无大写无数字、长度不足）不合规，会被跳过。
  #
  # 方式一：单账号模式（向后兼容）
  #
  # 方式二：多账号模式（推荐）
  #   accounts:
  #     - username: admin
  #       password: Admin@2024
  #     - username: ops
  #       password: Ops#2024abc
  #
  # 共存规则：
  #   - 两者同时配置时，会合并为最终账号列表共同生效
  #   - 若单账号的 username 与 accounts 中某账号同名，则忽略单账号（以多账号为准）
  #   - 两者均未配置时不阻止启动，仅告警（登录将全部失败）
  # ============================================================================

  # WebSSH 管理界面登录账号（单账号模式，无默认值，启动时校验）
  username: webssh
  # WebSSH 管理界面登录密码（单账号模式，无默认值，须符合上方强度规则）
  # 注意：默认值 "webssh" 不符合强度规则，会被判为无效账号无法登录，请务必修改
  password: Webssh-2026

  # 多账号列表（与 username/password 共存；用户名冲突时以多账号为准）
  accounts: [
#    {username: test, password: 123456},
#    {username: root, password: 123456}
  ]

  # SSH 主机列表
  hosts:
    - name: 【本地内网-192.168.1.166】
      host: 192.168.1.166
      port: 22
      # 可以不配置username&password，登录后在界面手动输入
      username:
      password:

    - name: 【测试服务器】
      host: 192.168.1.166
      port: 22
      # === （username&password）和 （privateKey&passphrase）可以二选一 ===
      # username: root									# 可以不配置username，登录后在界面手动输入
      # password: ssh-password							# 可以不配置password，登录后在界面手动输入

      # privateKey: /path/to/id_rsa
      # passphrase: private-key-password

  # 高风险命令正则列表（命中任意一条则拒绝通过终端执行）
  high-risk-commands:
    # === 文件系统破坏 ===
    - '^rm\s+-rf\s+/'                                   # rm -rf /  (删除根目录)
    - '^rm\s+-rf\s+/\*'                                 # rm -rf /* (删除根目录下所有文件)
    - '^rm\s+-rf\s+~'                                   # rm -rf ~  (删除家目录)
    - '>\s*/dev/sd[a-z]'                                # > /dev/sda (覆盖磁盘)
    - 'dd\s+if=.*of=/dev/'                              # dd 直接写磁盘
    - 'mkfs\.'                                          # mkfs.*    (格式化文件系统)
    # === 权限失控 ===
    - '^chmod\s+-R\s+777\s+/'                           # chmod -R 777 / (开放所有权限)
    - '^chown\s+-R\s+\w+:\w+\s+/'                       # chown -R 递归改所有者
    # === 系统关机/重启 ===
    - '^shutdown'                                       # shutdown
    - '^reboot'                                         # reboot
    - '^halt'                                           # halt
    - '^poweroff'                                       # poweroff
    - '^init\s+[06]'                                    # init 0 / init 6
    # === 进程与磁盘 ===
    - 'fdisk\s+/dev/'                                   # fdisk 磁盘分区
    - 'parted\s+/dev/'                                  # parted 磁盘分区

  # 登录安全策略（防暴力破解）
  login-security:
    max-fail-attempts: 5      							# 最大失败次数（0 或负数=关闭限制）
    lock-minutes: 5           							# 锁定时长（分钟）
    trust-forwarded-for: false 							# 是否信任 X-Forwarded-For（反代场景设为 true）
```

**步骤四：引入application-webssh.yml**

主配置`application.yml`文件引入配置：

```yml
# Spring 相关配置
spring:
  profiles:
    # 激活的配置文件（对应 application-webssh.yml）
    active: webssh
```

**步骤五：启动应用**

正常启动`Spring Boot`应用即可，Starter 会自动装配（默认 starter 通过 `AutoConfiguration.imports`，spring-boot2-starter 通过 `spring.factories`），无需额外注解或配置类。

访问 `http://your-host:port/webssh/login.html`，使用 `webssh.username` / `webssh.password` 登录后选择主机连接。

# 5. 配置项参考

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `webssh.enabled` | `true` | 是否启用 WebSSH |
| `webssh.context-path` | `/webssh` | 界面访问路径前缀 |
| `webssh.username` | 无（必填） | 管理界面登录账号 |
| `webssh.password` | 无（必填） | 管理界面登录密码 |
| `webssh.timeout` | `5000` | SSH 连接超时（毫秒） |
| `webssh.terminal-type` | `xterm` | 终端类型 |
| `webssh.charset` | `UTF-8` | 字符编码 |
| `webssh.host-key-verification` | `no` | 主机密钥校验（`yes`/`no`） |
| `webssh.known-hosts` | `~/.ssh/known_hosts` | known_hosts 文件路径 |
| `webssh.hosts` | 空 | SSH 主机列表 |
| `webssh.high-risk-commands` | 空 | 高风险命令正则列表 |
| `webssh.login-security.max-fail-attempts` | `5` | 最大登录失败次数 |
| `webssh.login-security.lock-minutes` | `5` | IP 锁定时长（分钟） |
| `webssh.login-security.trust-forwarded-for` | `false` | 是否信任代理转发头 |

## 5.1 主机配置项（`webssh.hosts[*]`）

| 属性 | 说明 |
|------|------|
| `name` | 主机显示名称 |
| `host` | 主机 IP 或域名 |
| `port` | SSH 端口，默认 `22` |
| `username` | SSH 用户名（可选，不填则界面手动输入） |
| `password` | SSH 密码（可选，与 `privateKey` 二选一） |
| `privateKey` | 私钥文件路径（可选） |
| `passphrase` | 私钥口令（可选） |

> **凭据来源优先级**：界面手动输入 > 配置文件预填。预填凭据的连接更便捷，但不填则更安全（登录后手动输入 SSH 凭据）。

## 5.2 文件上传大小限制

上传接口受 Spring Boot 全局 multipart 配置约束：

```yaml
spring:
  servlet:
    multipart:
      max-file-size: 100MB       # 单文件上限
      max-request-size: 500MB    # 单次请求上限
```

若使用 Nginx 反向代理，还需调整 `client_max_body_size`。下载接口为流式传输，无大小限制。

## 5.3 安全建议

1. **修改默认凭据**：`webssh.username` 和 `webssh.password` 无默认值，启动时强制校验，请使用强密码
2. **生产环境开启主机密钥校验**：设置 `host-key-verification: yes` 并配置 `known-hosts`
3. **配置高风险命令拦截**：根据团队规范添加正则规则，防止误操作
4. **反代场景注意 IP 识别**：使用 Nginx 时设置 `trust-forwarded-for: true` 以识别真实客户端 IP
5. **使用 HTTPS**：通过反向代理启用 TLS，保护 WebSocket 和登录凭据传输

## 5.4 API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/webssh/auth/public-key` | 获取 RSA 公钥（用于密码加密） |
| POST | `/webssh/auth/login` | 登录 |
| POST | `/webssh/auth/logout` | 登出 |
| GET | `/webssh/auth/check` | 检查登录状态 |
| GET | `/webssh/api/hosts` | 获取主机列表 |
| GET | `/webssh/api/hosts/info` | 获取主机详情 |
| POST | `/webssh/api/connect` | 建立文件管理 SSH 会话 |
| POST | `/webssh/api/disconnect` | 断开文件管理会话 |
| GET | `/webssh/api/files` | 列出目录内容 |
| GET | `/webssh/api/pwd` | 获取当前工作目录 |
| GET | `/webssh/api/suggest` | 路径自动补全 |
| GET | `/webssh/api/preview` | 预览文本文件（≤2MB） |
| GET | `/webssh/api/download` | 下载文件/目录 |
| POST | `/webssh/api/upload` | 上传文件 |
| GET | `/webssh/api/stat` | 获取文件/目录属性 |
| GET | `/webssh/api/calcSize` | 计算目录大小 |
| POST | `/webssh/api/resolve-cwd` | 解析`cd`命令后的工作目录 |
| POST | `/webssh/api/exec` | 执行非交互式命令 |
| GET | `/webssh/api/monitor` | 获取系统监控概览（CPU/RAM/Disk/Load/Net） |
| GET | `/webssh/api/monitor/detail` | 获取指定指标详情（`type=cpu`/`mem`/`disk`/`load`/`net`） |
| WS | `/webssh/ws` | WebSocket 终端通道 |

> 路径前缀 `/webssh` 可通过 `webssh.context-path` 自定义。

# 6. Nginx 反向代理配置

当 WebSSH Starter 被嵌入到现有项目并通过 Nginx 暴露对外服务时，需要正确配置反向代理，特别是 WebSocket 升级和长连接超时。

## 6.1 路由结构

默认 `webssh.context-path=/webssh`，所有路径都在该前缀下：

| 类型 | 路径 | 说明 |
|------|------|------|
| 静态资源 | `/webssh/login.html`、`/webssh/index.html`、`/webssh/images/**`、`/webssh/js/**`、`/webssh/style/**` | 前端页面与静态资源 |
| 页面跳转 | `/webssh`、`/webssh/logout` | 重定向到 `index.html` |
| 认证 API | `/webssh/auth/**` | 登录、登出、公钥、状态检查 |
| 文件 API | `/webssh/api/**` | 文件管理、监控、命令执行 |
| **WebSocket** | `/webssh/ws` | 终端通道（query 参数：`host`、`cols`、`rows`、`username`、`password`、`keyId`） |

## 6.2 关键约束（重要）

前端 JS 从浏览器地址栏动态推断 `contextPath`：

```javascript
const contextPath = window.location.pathname.replace(/\/[^/]*$/, '');
let wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${contextPath}/ws?...`;
fetch(contextPath + '/api/...');
```

由此衍生两条硬性约束：

1. **不能 rewrite 路径**：`proxy_pass` 末尾不能加 `/`（不要写成 `proxy_pass http://backend/;`），否则 URI 被改写后前端推断的 contextPath 与后端实际路径错位
2. **WebSocket 协议自动跟随**：站点是 HTTPS 时前端自动用 `wss://`，Nginx 这边 SSL 终止后用 HTTP 转给后端即可，后端无需配置 SSL

## 6.3 推荐配置（HTTPS + WebSocket）

假设后端应用监听 `127.0.0.1:8080`，对外域名 `example.com`：

```nginx
# HTTP -> HTTPS 跳转
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    # ZMODEM rz/sz 大文件 + 文件管理器上传，按需调整
    client_max_body_size 1024m;

    # ============ WebSSH WebSocket（必须单独 location 配置升级头）============
    location ^~ /webssh/ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 升级头（仅此 location 需要）
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";

        # ZMODEM rz/sz 大文件传输 + 长会话 SSH 操作，必须放宽超时
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;
        proxy_buffering     off;
    }

    # ============ WebSSH 其他路径（页面、静态资源、auth、api）============
    location ^~ /webssh/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ============ 业务应用其他路径 ============
    location / {
        proxy_pass http://127.0.0.1:8080;
        # 或 try_files $uri $uri/ /index.html; （前端 SPA 场景）
    }
}
```

## 6.4 关键点说明

### 6.4.1 为什么必须用 `^~`

Nginx location 匹配优先级：`=` > `^~` > 正则 > 普通前缀。若 WebSSH 用普通前缀 `location /webssh/`，会被如下正则规则截走：

```nginx
location ~ .*\.(gif|jpg|jpeg|png|bmp|swf)$ { ... }   # 拦截 /webssh/images/*.png
location ~ .*\.(js|css)?$ { ... }                    # 拦截 /webssh/js/*.js、/webssh/style/*.css
```

这些规则通常只设置 `expires` 缓存头，没有 `proxy_pass`，会用 `try_files` 兜底成 `index.html`，导致前端 JS/CSS/图片加载失败。加 `^~` 后，`/webssh/` 下所有请求都走反代规则，不再被正则匹配。

### 6.4.2 为什么 WebSocket 必须独立 location

`Upgrade`、`Connection` 升级头只对 `/webssh/ws` 路径生效。若加到普通 HTTP location 上，会污染静态资源请求。Nginx 按 `^~` 最长前缀匹配，`/webssh/ws` 会命中独立 location，普通请求走 `/webssh/`。

### 6.4.3 超时与缓冲

| 配置项 | 推荐值 | 原因 |
|--------|--------|------|
| `proxy_read_timeout` | `3600s` | ZMODEM 大文件传输、长 SSH 会话默认 60s 会被切断 |
| `proxy_send_timeout` | `3600s` | 同上 |
| `proxy_buffering` | `off`（仅 ws） | 关闭缓冲确保终端实时响应 |
| `client_max_body_size` | `1024m` | 文件管理器上传大文件需要 |

### 6.4.4 IP 锁定功能（可选）

默认 `webssh.login-security.trust-forwarded-for=false`，不信任 `X-Forwarded-For` 等转发头（防伪造）。若希望登录失败锁定基于真实客户端 IP，需要在 `application.yml` 中开启：

```yaml
webssh:
  login-security:
    trust-forwarded-for: true
```

同时 Nginx 必须传递 `X-Forwarded-For` / `X-Real-IP`（上方配置已包含）。

## 6.5 子路径部署场景

若整个应用部署在子路径下（如 `/myapp/`），需同步调整 WebSSH 的 `context-path`：

```yaml
webssh:
  context-path: /myapp/webssh
```

Nginx 配置：

```nginx
location ^~ /myapp/webssh/ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}

location ^~ /myapp/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## 6.6 验证

部署后访问 `https://example.com/webssh/login.html`：

- 登录页能打开 → 静态资源 location 正常
- 登录成功 → auth API 反代正常
- 打开终端能连 SSH → WebSocket 升级头配置正确
- rz/sz 传大文件不断 → `proxy_read_timeout 3600s` 生效

# 7. WebSSH相关项目推荐

Guacamole：[https://github.com/apache/guacamole-server](https://github.com/apache/guacamole-server)

ttyd：[https://github.com/tsl0922/ttyd](https://github.com/tsl0922/ttyd)

# 8. 致谢

本项目站在以下优秀开源项目的肩膀上，衷心感谢它们的作者与社区：

**后端**

- [Spring Boot](https://spring.io/projects/spring-boot) — 应用框架、自动配置与 WebSocket 支持
- [JSch](https://github.com/mwiede/jsch) — SSH 协议客户端（mwiede 维护的活跃 fork）
- [pty4j](https://github.com/JetBrains/pty4j) — 本地 PTY 终端支持（JetBrains 开源）

**前端**

- [xterm.js](https://github.com/xtermjs/xterm.js) — 浏览器端终端模拟器
- [xterm-addon-fit](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) — xterm 尺寸自适应插件
- [zmodem.js](https://github.com/kuasha/zmodem.js) — ZMODEM 协议实现（rz/sz 文件传输）
- [JSEncrypt](https://github.com/travist/jsencrypt) — RSA 加密库（登录密码传输加密）

**构建工具**

- [Apache Maven](https://maven.apache.org/) — 项目构建与依赖管理

感谢所有为开源社区贡献力量的人。
