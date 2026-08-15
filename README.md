# dsh-session-timeline

[English](README.en.md) | 中文

DeepSeek Harness 会话时间轴插件：在会话左侧渲染一条**横短横线时间轴**，用于在长会话中快速定位、跳转和预览。

![platform](https://img.shields.io/badge/platform-web-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![npm](https://img.shields.io/npm/v/dsh-session-timeline)

## 效果

![会话时间轴主视图](docs/screenshots/timeline-main.png)

![悬停预览 tooltip](docs/screenshots/timeline-tooltip.png)

## 功能

- **横短横线时间轴**：只在用户输入的位置显示一条横向短横线，无消息处无线；条数等于**整个会话**的用户消息数，放得下时居中排布，放不下时时间轴内部滚动（无滚动条）。
- **全量统计（投影机制）**：通过 DSH sessionProjections 增量统计整个会话的用户消息与 AI 回复预览，持久化缓存保证刷新秒出、新消息实时更新；对长会话压力可控。
- **当前消息定位（scroll-spy）**：激活条始终对应右侧视口当前显示的那条用户消息；滚动右侧对话，激活条随之移动（手动滚动时间轴后保持不动，点击某条跳转后恢复跟随）。
- **波浪聚焦**：鼠标在时间轴上移动时，鼠标接近的那条变为激活色并变长，相邻条向上下递减，形成波浪效果。
- **圆角预览 tooltip**：悬停某条时立即显示圆角提示——第一行用户消息（黑色加粗、单行省略），下方 AI 回复（灰色、多行），时间贴在最后一行右下角；字体与右侧对话一致。窗口外的历史消息同样可以预览。
- **点击跳转**：点击任意横线，对话立即滚动到该次用户输入所在位置；窗口外（未加载）的历史消息会自动加载更早历史后跳转。
- **收起 / 展开**：第一条消息上方有一个悬停淡入的**胶囊把手**（点击收起；悬停时第一、二条灰色递减，胶囊扮演激活条角色）。收起后变成一条**全高细竖条**，常态隐藏，鼠标接近识别区域时淡入，点击展开。任何滚动位置，胶囊与最上方条目之间始终保留固定空白。

## 安装

需要 DSH ≥ 0.1.0-rc（`dsh` CLI 已安装，web profile 含 sessionProjections 服务）。

### 方式一：npm 安装（推荐）

已发布到 npm，预构建安装**无需 GitHub 构建授权**：

```sh
dsh plugin --profile web add dsh-session-timeline
```

然后启动（或重启）web：

```sh
dsh web
```

### 方式二：GitHub 安装

```sh
dsh plugin --profile web add github:XiLuovo/dsh-session-timeline
```

然后启动（或重启）web：

```sh
dsh web
```

> 本包是纯 JS 实现，`client.js` 即最终 bundle 产物，**无需 prepare 构建脚本**，GitHub 直接安装即可用。

### 方式三：本地目录安装（开发调试）

```sh
git clone https://github.com/XiLuovo/dsh-session-timeline.git
dsh plugin --profile web add ./dsh-session-timeline
dsh web
```

### 方式四：会话内动态加载（快速体验，不落盘）

在 DSH Web 会话中让 agent 执行 `cordis_define`，粘贴 `client.js` 的内容作为 client 代码，`cordis_run` 启用。适合快速体验；注意动态方式没有 host 投影（全会话统计不可用），仅保留窗口内功能。

### 卸载

```sh
dsh plugin --profile web remove dsh-session-timeline
```

## 使用

打开任意会话，时间轴出现在对话区左侧：

| 交互 | 效果 |
| --- | --- |
| 悬停时间轴某条 | 显示该轮的用户消息 + AI 回复预览（圆角 tooltip） |
| 点击横线 | 跳转到对应消息（窗口外自动加载历史） |
| 鼠标在时间轴上移动 | 波浪跟随（激活条 + 长度递减） |
| 滚动时间轴 | 条目内部滚动（无滚动条），手动滚动后保持位置 |
| 悬停第一条上方的胶囊 | 胶囊淡入，第一、二条灰色递减 |
| 点击胶囊 | 收起时间轴 |
| 收起后悬停/点击竖条区域 | 竖条淡入 / 展开时间轴 |

## 依赖

完全建立在 DSH 宿主之上：

| 依赖 | 用途 | 来源 |
| --- | --- | --- |
| `@deepseek-ai/dsh-client-runtime` | 会话快照、useSessions、投影读取 faceOf | 宿主自带（peer） |
| `@deepseek-ai/dsh-client-ui-layout` | shell.overlay 浮层槽位 | 宿主自带（peer） |
| `@deepseek-ai/dsh-session-projection` | 投影注册 + 事件流 fold + 持久化缓存 | 宿主自带（peer） |
| `zod ^4.4.3` | 投影 schema（数据校验） | 包自带（dependencies） |
| DSH 主题 CSS 变量（`--dsw-alias-*`） | 亮暗主题自适应 | 宿主 |

## 开发说明

- **client.js**：纯 JS UI（波浪、scroll-spy、tooltip、胶囊、内部滚动），无构建步骤，修改后直接提交；
- **index.js**：投影 fold 数学（`init`/`apply`/`view` + 紧凑截断）。**修改投影状态结构时必须 bump `stateVersion`**，否则旧持久化缓存会被错误复用；
- 浏览器半部通过 `exports["./client"]` 被发现，`dsh.client` 声明了运行依赖；
- 插件只读 `sessions.binding(sessionId).session` 快照、投影与 DOM 锚点（`data-chat-anchor-key`），不修改会话数据。

## License

MIT
