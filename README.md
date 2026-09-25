# dsh-translator

DSH Web GUI 的**划选翻译**插件：在对话里用鼠标划选一段英文（Think 推理行、中间步骤正文、任意片段），点出现的「译」按钮，译文就在**右侧边栏的「翻译」页签**里由 AI 流式产出。

**纯显示层**：译文只存在于浏览器与本插件的缓存里，不写入会话日志、不进入模型上下文、不影响回放与缓存命中。

```
划选 → 「译」按钮（或拖到面板 / Ctrl+Shift+T）
      → 右侧边栏「翻译」页签 → 官方 LLM (ctx.llm.stream) 流式中文译文
```

> **非官方插件**：本项目是 DSH（DeepSeek Harness）的第三方社区作品，与 DeepSeek 官方**没有隶属、赞助或背书关系**。「DSH」「DeepSeek」等名称仅用于说明本插件所适用的宿主与所调用的公开扩展点。
>
> **第三方代码**：本仓库不包含也不再分发任何第三方源码。产物 `lib/client.js` / `lib/index.js` 均为本仓库自有实现；`react`、`react-dom` 等依赖在运行时从宿主 DSH 的模块表按需加载，不随本包分发。
>
> **动手改交互前先读 §「已知坑与排查」**：那里按症状记录了 7 个已经踩过、且回归测试正在守着的坑（**任何 client entry 停在 pending 会让整个 Web UI 起不来** / 座位 key 必须用定义 `id` / capture 阶段 `mousedown` 会吃掉自己的 click / 重试计数器与请求函数同名 / 空白面板=渲染抛错被退位 / hooks 阶段抛错拦不住 / 数据 prop 不能叫 `ref`），以及 `?dsht-debug=1` 两块诊断面板的判读表。

## 安装

```powershell
# 一条命令装（推荐）
dsh plugin --profile web add github:madoka333/dsh-translator

# 本地目录（本机开发方式）
dsh plugin --profile web add link:<克隆到本地的路径>
```

> ⚠️ **不要**用 `dsh plugin --profile web add dsh-translator`：npm 上的裸名 `dsh-translator` 是**另一个人的包**（维护者 `jannchie`，一个 DeepL 风格的双栏翻译面板），与本项目无关。本项目目前**没有发布到 npm**；将来若发布，会用带 scope 的名字（如 `@madoka333/dsh-translator`）。

然后**重启 `dsh web`**（宿主半边改动必须重启；之后只改客户端半边刷新页面即可）。

卸载：

```powershell
dsh plugin --profile web remove dsh-translator
```

## 依赖与版本

**本插件不打包任何依赖**。产物 `lib/client.js` 在运行时只 `require` 三个外部模块（`react`、`react-dom`、`react-dom/client`），其余全是自身内部模块；`lib/index.js` 零外部依赖、零动态 `import()`。这三个 React 模块由 DSH Web 前端的模块表在浏览器里提供，**不从 npm 安装**。

因此**没有需要你安装的依赖**：上面那条 `dsh plugin add` 装完即可用。

### 实测环境（本节版本为实机核对，非推测）

| 组件 | 版本 | 来源 / 说明 |
|---|---|---|
| **DSH 本体**（`dsh` CLI） | **`0.1.7-rc.2`** | 实机 `dsh --version`；端到端跑通（见下） |
| DSH 客户端插件（`@deepseek-ai/dsh-client-ui-*` 等） | **`0.1.7-rc.2`** | 随本体同版本发布 |
| **React / ReactDOM**（本插件唯一的外部模块） | **`18.x`**（前端声明 `^18.2.0`） | 由 `@deepseek-ai/dsh-web-frontend` 打进 shell，浏览器运行时提供 |
| **`@deepseek-ai/cordis`**（宿主插件运行时，`peerDependencies`） | **`^4.0.2`** | npm 上 `latest = 4.0.2`；与官方 `dsh-client-ui-*` 的声明**逐字一致** |
| **`@deepseek-ai/dsh`**（`peerDependencies`，**版本闸门**） | **`>=0.1.6-0 <0.2.0`** | DSH 的 `evaluatePluginCompatibility` 只认这个前缀；越界时**跳过整个 bundle 并报错**，而不是让插件去把 GUI 弄崩 |
| **Node.js**（`engines`） | **`>=22`** | 实测 `v24.15.0` |

### 依赖面清单

```jsonc
// package.json
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.2",   // 宿主插件运行时，与官方插件声明一致
  "@deepseek-ai/dsh": ">=0.1.6-0 <0.2.0",  // 版本闸门，见下
  "react": "^18.2.0"                 // 客户端半边实际 require 的三个模块
},
"peerDependenciesMeta": {
  "@deepseek-ai/cordis": { "optional": true },
  "react": { "optional": true }      // 由宿主 shell 提供，绝不是 npm 依赖
},
"engines": { "node": ">=22", "dsh": ">=0.1.6-0 <0.2.0" }
```

> 之所以把 `cordis` / `react` 两个 peer 标 `optional`：它们**在安装期都不该被 pnpm 去 npm 上拉取**——`cordis` 由宿主运行时提供，`react` 由浏览器 shell 提供。标成 optional 是为了让 `dsh plugin add` 在任何 profile 里都**静默通过**（实测：全新 profile 安装**零 peer 警告**）。
>
> **`@deepseek-ai/dsh` 故意不标 optional。** DSH 启动时会用 `peerDependencies` 里所有 `@deepseek-ai/dsh*` 项去比对运行时版本，**不满足就跳过这个 bundle 并打印原因**（实测：`dsh: skipping profile bundle "dsh-translator": Error: Plugin dsh-translator@0.1.0 is incompatible with dsh 0.1.7-rc.2 …`）。这是**故意要的**：将来 DSH 跨到 `0.2` 时，你要的是"插件被明确拒绝加载 + 一条说清原因的消息"，而不是"插件把整个 Web UI 卡在开机画面"。想强行放行用 `dsh plugin allow-version`（DSH 官方逃生门）。

### 装完会发生什么（已实测）

在全新空 profile 里执行 README 那条命令，实测结果：

```
dependencies:
+ dsh-translator git+https://github.com/madoka333/dsh-translator.git
Packages: +1
Done in 19.2s using pnpm v11.22.0
```

- 包的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，DSH 会**自动**把插件插进 profile 配置树，**无需手工改 profile**。实测 `dsh --profile web --dump-config` 输出：
  ```yaml
  - id: dsh-translator
    name: dsh-translator
  ```
- **没有 `prepare` 脚本**，`lib/` 产物已入库 ⇒ git 来源安装**不会**触发 pnpm 的"构建脚本被拦截"警告，也**不需要**往 `pnpm-workspace.yaml` 加 `allowBuilds`
- 实测：装完的包内**不含** `node_modules`、`.evidence`、`HANDOVER.md`，产物完整（`lib/client.js` 97,821 B、`lib/index.js` 40,202 B）

### 版本兼容性提示

- **DSH `0.1.7-rc.2`**：本版适配并端到端实测通过（划选 → 译 → 右侧栏出中文译文，0 报错；引用列表按 Session 命名空间落盘）。插件只用公开扩展点（`webServer.register` / `tapIndex`、`sidebarRight` 座位、`sidebarRightTabs.register`、`settings.general.item`、`ctx.llm.stream`、`uiSession.adapter.current`）。
- **DSH `0.1.6-*`**：仍可用。0.1.6 没有 `uiSession.adapter`，会话命名空间会退回 `default`（多会话共用一份引用列表），其余功能不受影响——因为取服务失败只会让那一项能力停摆。
- **DSH `0.2+`**：`peerDependencies["@deepseek-ai/dsh"]` 不满足 ⇒ **DSH 会在启动时明确拒绝加载本插件**（不会把 GUI 弄崩）。升级前先跑 `npm run compat`。
- **某次 DSH 升级后整个 Web UI 卡在 `Failed to load plugins`**：这是 DSH 客户端启动的判定方式导致的（任何一个 client entry 不是 active 就抛），排查入口见 §「已知坑与排查」0；预防手段是 `npm run compat`。
- **Node `< 22`**：`engines` 不满足。构建期（`npm run build`）用到较新的 ESM/正则特性，请用 Node 22+。
- **升级 DSH 后的三步**（顺序别换）：
  ```powershell
  npm run compat     # 1) 离线静态核对：本插件绑定的服务/槽位在新 DSH 里还在不在
  npm run verify     # 2) 重建 + 92 个测试 + 产物契约
  node tools\cdp-boot-probe.mjs   # 3) 真浏览器：页面还起不起得来（需 9222 上的 headless Chrome）
  ```



1. 在对话里**划选**想看的英文（≥ 8 个字符）。
2. 松手后出现「译」胶囊按钮 → 点击。右侧边栏自动展开并切到「翻译」页签，译文逐字出现。
3. 继续划选 → 新引用加到列表顶部；同一段内容再引用一次会直接命中缓存，不再请求模型。

其他入口：

| 方式 | 说明 |
|---|---|
| 拖拽「译」按钮到面板 | 与点击等价，拖到面板任意位置松手即翻译 |
| 把任意文字拖进「翻译」页签 | 页签整体是拖放区，拖进去的内容直接翻译 |
| **页签最底部的输入框**（beta） | 打字或粘贴 → `Enter` 当新引用送去翻译；`Shift+Enter` 换行。见下节 |
| `Ctrl+Shift+T` | 翻译当前选区；没有选区时只打开页签（快捷键可在设置里改） |
| 设置 → 通用 → 划选翻译 | 目标语言、代码块跳过、Think/正文开关、快捷键 |

页签里的每张卡片都可以：复制译文 / 复制原文 / 重新翻译 / 取消 / 删除。顶部工具条可切换目标语言与清空列表。

## beta：页签最底部的输入框

> 这是 **`beta/chat-box` 分支**上的实验功能，版本号 `0.2.0-beta.1`。`main` 保持稳定，回退一条命令：
> ```powershell
> git -C D:\data\dsh\dsh-translator switch main && node D:\data\dsh\dsh-translator\build.mjs
> ```

「翻译」页签的**最底部**有一个输入框，用来看你说的这种情况：手里已经有一段文字（剪贴板里的、别处复制来的、自己想写的），不想为了翻译它先去对话里把它造出来再划选。

| 操作 | 结果 |
|---|---|
| `Enter` | 把框里的内容当作**一条新引用**，走完全相同的翻译链路（分块、代码遮蔽、流式、缓存、卡片操作全都一样），卡片来源标记为「手动输入」 |
| `Shift+Enter` | 换行，不提交 |
| 右侧「翻译」按钮 | 与 `Enter` 等价（框空时禁用） |
| 把文字**拖进输入框** | 暂存进输入框等你编辑，**不会**直接翻译（拖到面板其它地方仍然直接翻译） |
| 框里是中文 / 只有空白 | 不提交，提示一下。空白是无操作 |
| 输入法选词回车 | 不提交（`composing` 期间不认 Enter） |

**「输入暂存」**：框里的内容按会话存在浏览器本地（`dsh-translator:draft:` 前缀 + 会话 id），每敲一个字就存一次。**刷新页面或切走再切回来，没提交的字还在**；成功提交后该条暂存被清掉（提交失败则保留，不让你丢字）。

**它不是聊天框，这点是故意的。** 本插件的硬约束是"纯显示层"：它收集和显示的任何东西都不进会话日志、不进模型上下文。一个真聊天框会直接破坏这条。所以这个框干的事和浮动「译」按钮**完全一样**，只是入口换成了"我自己打"；它没有给模型开任何新的对话通道。

要真正做聊天，得先决定要不要放弃"纯显示层"这条约束——那是另一个决定，不是这个 beta 的范围。

## 行为细节

- **只翻译用户引用的内容**——不自动翻译整轮回答，也不改动模型输出。
- **划选中文不会打扰你**：判定「已是中文」时只提示，不发请求。
- **代码不送翻译**：命令行、路径、URL、行内参数与围栏代码块会被替换成 `⟪code⟫` 占位符，模型看到的是占位符，显示时原位还原成原文。
- **长文本分批**：超过约 400 字的引用按段落/句子切成多段串行翻译，按序拼接。
- **失败降级**：认证/额度/超时/空回答都会在卡片上显示错误码与原因，可单独重试；联网失败会自动退避重试 2 次（仅在尚无译文时）。
- **每会话独立**：引用列表按 Session 存在浏览器本地（`dsh-translator:refs:<sessionId>`），切换会话各自一份，刷新页面后仍在。当前会话是**从座位自己的 `sessionId` prop 与 `uiSession.adapter.current` 拿的**——DSH 0.1.7 把 `current` 从 `sessions.list` 快照里删掉了，旧写法会让所有会话共用名为 `default` 的那一份。

## 已知坑与排查（改交互前先读）

### 0. 任何 client entry 停在 pending，整个 Web UI 就起不来（0.1.7 的 `settingsScope` 事故）

这是**启动级**的规矩，比下面所有条都重要，因为它坏的不是本插件而是整个 dsh。

DSH 的 Web 前端启动时会遍历**每一个 client loader entry**，只要有一个不是 `active` 就抛：

```js
// dsh-web-frontend（压缩产物，语义如此）
if (o.length > 0) throw new Error(`web boot: ${o.length} entries did not activate\n${o.join('\n')}`)
```

而 `pending (waiting for service: X)` **也算 not active**。于是"某个插件在 `inject` 里声明了一个新版 dsh 已经改名的服务"这件事的代价是：

```
HARNESS
Failed to load plugins
web boot: 1 entry did not activate
dsh-translator: pending (waiting for service: <被删掉的服务名>)
```

页面**只**剩这块开机画面——没有输入框、没有侧栏，主应用压根没挂载。**一个可选插件能把整个 GUI 拉黑。**

真事：DSH `0.1.6-alpha.2 → 0.1.7-rc.2` 重写了设置接缝，客户端侧的 `settingsScope` 服务被整个删掉。本插件的浏览器半边当时在 `inject` 里列着 `settingsScope`（虽然代码从来没调过它），于是升级当天整个 Web UI 起不来。

**本插件的对策（三层，缺一不可）**：

| 层 | 做法 | 在防什么 |
|---|---|---|
| 声明 | `export const inject = []` —— **一个硬依赖都不声明** | 服务改名再也不会让本插件 pending |
| 取用 | 每项能力各自 `ctx.inject([...服务], cb)` 开**子 fiber**；服务缺失只让那项能力停摆 | 子 fiber 不是 loader entry，`web boot` 的检查看不到它 |
| 兜底 | 所有服务都用 `ctx.get(name)` 读，读不到就降级（面板 → 浮层卡片） | `apply` 必须在"什么都没有"的页面里也跑完 |

**实测证据**（`tools/cdp-boot-probe.mjs`，真 Chrome）：

| 场景 | 结果 |
|---|---|
| 故意在**子 fiber** 里声明一个不存在的服务 | 页面**正常挂载**（输入框在、应用在），那项能力静默停摆 |
| 同一个不存在的服务放在**顶层 `inject`** | `web boot: 1 entry did not activate` —— 页面卡死在开机画面（复现事故） |

后者是对照组：它证明前者不是"探针没生效"，而是**子 fiber 确实不在 dsh 的启动判定范围里**。

**升级 dsh 后的纪律**：先 `npm run compat`（离线静态核对本插件绑定的服务/槽位在新 dsh 里还在不在），再 `npm run verify`，最后 `node tools\cdp-boot-probe.mjs` 真浏览器确认页面起得来。三步的顺序别换。

> 另注：这条只在**客户端**成立。宿主侧同样是 pending 的 entry，`dsh-app-boot` 只当**警告**处理（`activationDiagnostic`），不影响启动策略。

### 1. 侧边栏座位必须按定义 `id` 注册，不是按 `kind`

症状最好认：**点了「译」、侧边栏展开了，但面板位置显示的是那句兜底文案「这类内容还没有可用的查看方式。」**（英文 `tab.unavailable`）。

原因在 `@deepseek-ai/dsh-client-ui-sidebar-right` 的 `TabSlot`：

```js
entryKey: definition?.id ?? tab.kind,   // 派发时用的 key
```

它按**标签类型定义的 `id`** 去查 `sidebar.right.pane.tab` 与 `...pane.tab.title` 两个座位。我一开始把座位注册在 `kind`（`'translator'`）上、而定义 `id` 是包名（`'dsh-translator'`），两者不等 ⇒ 座位查不到 ⇒ 直接渲染那份兜底文案；`openTab(kind)` 本身是成功的，所以侧边栏确实会打开，看起来像"打开了但没内容"。

**规则**：`id` 与 `kind` 是两个不同的东西，各有用途，都别偷懒复用一个常量。

| 常量 | 值 | 用途 |
|---|---|---|
| `TAB_ID` | `'dsh-translator'`（包名） | 定义 `id`，**两个座位注册的 `key`** |
| `KIND` | `'translator'` | `openTab()` 的目标类型 |

回归测试断言的是不变量本身——`seatKeys` 必须等于**注册时那个 definition 的 `id`**，并且顺带断言 `kind !== id`，免得以后有人把两者合并又踩回来。

### 2. 不要在 capture 阶段的 `mousedown` 里抹掉自己的按钮

浮标按钮曾经**一点就"没反应"**。原因不是没绑定 `click`，而是事件的先后顺序：`document` 上捕获阶段的 `mousedown` 先把候选清空并重渲染，按钮在 `mousedown` 阶段就被卸载，浏览器于是不再向它派发 `click` —— 按钮看上去"点不动"。

**规则**：任何"按下即收起"的逻辑（浮标、菜单、popover）都必须先判断事件目标是否落在自家 UI（`[data-dsh-translator-ui]`）里；落在里面就**只记录手势、不收起**。这条判断被抽成纯函数 `handleMouseDown(event, current, now)`（`src/client/watch.js`），并由 `test/client.test.mjs` 里的回归测试直接守着——包括"按下自家按钮必须返回 `dismissed: false`"这一条。

配套：浮标的位置在**渲染期**算（`pillAnchorFor`，纯函数、只读视口尺寸），不放 `useEffect`。放 effect 会让首帧返回 `null`，任何需要拿到按钮元素的消费者都得等第二次渲染。

### 3. 传输层：重试循环的计数器不能和请求函数同名

更狠的一次故障：**侧边栏打开了、卡片一直在"翻译中…"、连一个网络请求都没发出去**。

原因是 `translate()` 里的名字遮蔽：

```js
for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
  return await attempt({ … })   // ← 这里的 attempt 是数字，不是函数
}
async function attempt(request) { await fetch(…) }
```

循环计数器 `attempt` 在循环体内把同名函数遮掉了，`await attempt({...})` 于是抛 `TypeError: attempt is not a function`。它被 `catch` 吞成"可重试失败"，重试两次、每次退避 0.5s/1.5s，最后才变成卡片上的一行错误——而 `fetch` **从头到尾没被调用过**。用户看到的就是"卡住不输出"。

**规则**：重试循环的索引叫 `tryIndex`，请求函数叫 `attemptOnce`（`src/client/query.js`），两个名字两个职责。真正的防线是测试：`translate() reaches fetch, consumes the stream, and returns the answer` **用真 `translateExport` 打一个 stubbed `fetch`**，断言"恰好一次请求 + 每个 delta 都按序转发 + 结果正确"。任何只在函数内部发生、不会碰网络的错误（名字遮蔽、`this` 丢失、早期 `return`）都只有这种测试抓得到——用假 translator 的 store 测试永远抓不到。

### 4. 排查"点了没反应 / 卡在翻译中"

1. 浏览器控制台看 `[dsh-translator]` 前缀的行：`sidebarRight` 不可用、内容无需翻译、渲染失败都会打日志；`TypeError` 之类也会以红字出现（就是第 2 类）。
2. 用 `Ctrl+Shift+T` 走同一条 `commitSelection`：快捷键正常而按钮异常 → 属于第 2 类事件竞态；两者都不动 → 看第 4 条。
3. 在页面上直接跑一次真请求（不经插件 UI），确认宿主与模型链路：
   ```powershell
   curl.exe -N -X POST http://127.0.0.1:3080/dsh-translator/translate `
     -H 'content-type: application/json' -H 'host: 127.0.0.1:3080' `
     -d '{"text":"Let me check the repository layout first."}'
   ```
   有 `start` → 多个 `delta` → `done` 且是中文 ⇒ 宿主正常，问题在浏览器半边（看第 1、2 条）；否则看 `GET /dsh-translator/health` 的 `llm`/`route` 字段。
4. 右侧边栏不可用时，插件会退化成浮层卡片并在卡片上写明原因，**不会出现"点了什么都没有"**。

### 5. `?dsht-debug=1`：让页面自己交代状态

**任何"面板空白 / 没有译文"的排查都从这里开始**，因为它一次回答六个问题，而且不需要开 DevTools：

```
http://127.0.0.1:3080/?token=<你的一次性 token>&dsht-debug=1
```

有**两块**面板会同时出现，它们互相独立、互为备份：

| 面板 | 谁提供 | 依赖 |
|---|---|---|
| 左下角「**dsh-translator 宿主探针**」 | **宿主**（`webServer.tapIndex` 注进 HTML 的内联脚本） | 只依赖浏览器；**不依赖客户端插件是否加载成功**，所以"客户端插件整个没跑"它也能说话 |
| 左下角偏上「**dsh-translator 自检**」 | 客户端插件 | 依赖客户端 bundle 已加载（`bundle` 那行会打出它是哪个 build） |

宿主探针每 750ms 刷新一次，报告的是 DOM 事实：插件节点数、样式标签、**`data-slot-error`（座位被退位=组件渲染抛错）**、**`data-sidebar-right-unavailable`（座位 key 不匹配）**、`.dsht-pane` 是否存在及其文本、以及页面上的 JS 报错。这两块面板的差别本身就是证据：**只有宿主探针出现** ⇒ 客户端插件没加载/加载失败；**两块都有但 `.dsht-pane` 是 NO** ⇒ 组件渲染问题。

> **`?dsht-debug=1` 会被登录跳转吃掉。** 带 token 打开时服务器回 `303 → Location: /`，**整个查询串（token 和 `dsht-debug` 一起）都被丢掉**，所以直接敲那行 URL 大概率看不到任何面板。两个办法：
> - 先用带 token 的 URL 打开一次（让鉴权 cookie 落地），再**手动把 `?dsht-debug=1` 补到地址栏**回车；
> - 或者在已登录的页面上执行 `history.replaceState(history.state, '', '/?dsht-debug=1')` 再刷新。
>
> 两条诊断通道（宿主探针、客户端自检）**都**读 `location.search`，所以是被同一个跳转一起打掉的——这也意味着"两块面板都没出现"**不能**推断成插件坏了。

> 宿主探针是宿主半边改动：**加它之后需要重启一次 `dsh web`**。客户端自检只需刷新页面。

客户端自检面板还会多打这些运行时诊断行：

| 行 | 它在回答什么 |
|---|---|
| `bundle` | **页面跑的是哪个 build**。和 `lib/client.js` 的构建时间一比就知道是不是旧产物——浏览器只在页面加载时取一次客户端 bundle，**每次 `node build.mjs` 之后必须刷新页面**，否则你看到的是旧代码，和"新 bug"长得一模一样 |
| `styles tag` | 样式表注入了没有 |
| `services` | `slots` / `sidebarRight` / `sidebarRightTabs` / `sessions` 四个服务在不在 |
| `tab id / kind` + `seat keys` | 定义 `id`、`openTab` 用的 `kind`、两个座位注册的 `key`（必须 `key === id`，见第 1 条） |
| `slots.snapshot` / `slot.title` / `tab types` | **官方运行时诊断**：座位里到底有没有我的条目、是否 `inactive`（=渲染抛错被退位）、已注册的 `id/kind` 对 |
| `refs` | 引用列表的真实状态（`done:12字` 这种），区分"没建引用"和"建了没显示" |
| `render errors` | 渲染失败记录（由 `useSafeSnapshot` 与 `recordRenderFailure` 写入） |
| `openTab` / `pane render` | 直接调用一次 `openTab(kind)` 与面板组件，看谁抛错 |

判读口诀：**空白面板 = 座位条目被退位（组件渲染抛错，DOM 里只剩 `div[data-slot-error]`）；那句"这类内容还没有可用的查看方式。" = 座位 key 和定义 `id` 不一致**（见第 1 条）。

### 6. 绝对不要把数据 prop 命名成 `ref`（组件会拿到 `undefined`）

`ref` 和 `key` 一样是 **React 保留 prop**：`React.createElement(RefCard, { ref: someData })` 会让 React 把 `someData` 当成"元素引用"收走，**组件里 `props.ref` 永远是 `undefined`**。

本项目真栽在这上面一次：卡片组件写成 `function RefCard({ ref, … })`，于是**第一张卡片一渲染就抛** `Cannot read properties of undefined (reading 'sourceLabel')`，座位被退位，面板变成空白（DOM 里只剩 `data-slot-error="sidebar.right.pane.tab"`）——"划选能出「译」按钮、点了却什么都不显示"就是这个。现在数据走 `item` prop（见 `src/client/TranslatePane.jsx`）。

**为什么原来的 78 个测试没抓到**：`test/client.test.mjs` 的 React 桩 `createElement` 会把 props 原样透传，而真 React 会剥掉 `ref`。桩现在**忠实模拟了这个行为**，并且断言"任何组件元素都不许带 `ref` prop"——所以这个 bug 再写回去，测试就会红（已实测：打回旧写法 → 77 通过 / 1 失败）。

**改 UI 时的自查**：组件里任何 `ref` 只应该是真·DOM 引用（`<div ref={boxRef}>`）；别把业务数据叫 `ref`。

## 配置

### 部署级（`cordis.patch.yml` / profile 覆盖）

```yaml
- insert:
    - id: dsh-translator
      name: dsh-translator
      config:
        provider: deepseek-official     # 可选；与 model 必须成对出现
        model: deepseek-v4-flash        # 可选；不填则跟随当前会话/默认模型
        targetLanguage: zh-CN           # zh-TW / en / ja / ko / es / fr / de / ru
        timeoutMs: 30000                # 单次翻译调用超时
        maxOutputTokens: 4096           # 单次翻译输出上限
        cacheSize: 500                  # 宿主侧译文缓存条数
        verbose: false                  # 每次翻译打一行日志
```

不写 `provider`/`model` 时的路由优先级：**单次请求覆盖 → 配置 → 当前会话/默认模型（`agent-default-model`）→ `deepseek-official` + `deepseek-v4-flash`**。每个候选都会先向适配器注册表确认可用，不可用就顺延，不会因为一个过期的模型名让插件整体失效。

### 为什么没有 `Config` 导出（改这里之前请先读）

**不要给这个插件加回 `Config` 导出。** cordis 校验配置走的是 standard-schema 契约 —— `runtime.Config["~standard"].validate(rawConfig)`（见 `@deepseek-ai/cordis` 的 `resolveConfig`）。把一个只实现 `.default()/.min()/.max()` 的 schemastery 风格对象挂到 `Config` 上，加载器在 `~standard` 处读到 `undefined`，报 `Cannot read properties of undefined (reading 'validate')`，并且**整个 plugin tree 加载失败、`dsh web` 起不来**——挂掉的不是这一个插件，是所有插件。

所以本插件**不导出 `Config`**，校验放在 `apply()` 里由 `resolveConfig()` 完成：没有 schema 时加载器把原始配置透传，坏配置仍在启动时大声抛错，但影响被限制在本插件内。`npm run verify` 有一条断言专门守着它（`host must not export a Config schema`），加回来就会构建失败。

### 用户级（浏览器 localStorage）

目标语言、代码块跳过、Think/正文开关、快捷键存在浏览器本地，设置面板里改；不写回 `settings.yaml`。

## HTTP 面

| 路由 | 说明 |
|---|---|
| `POST /dsh-translator/translate` | body `{text, kind?, lang?, route?, sessionId?}`，返回 SSE：`start` / `delta` / `done` / `error` |
| `GET /dsh-translator/health` | `{ok, llm, route}`，可用来确认插件与模型路由是否就绪 |

两条路由都只接受 loopback `Host`（`127.0.0.1` / `localhost` / `[::1]`），其余一律 403；非 POST 405；body 上限 32 KB。

手工验证：

```powershell
# 就绪状态（含当前解析到的模型路由）
Invoke-RestMethod http://127.0.0.1:3080/dsh-translator/health

# 真打一次翻译（会消耗一次模型调用）
curl.exe -N -X POST http://127.0.0.1:3080/dsh-translator/translate `
  -H 'content-type: application/json' -H 'host: 127.0.0.1:3080' `
  -d '{"text":"Let me check the repository layout first.","kind":"reasoning"}'
```

## 开发

```powershell
npm run build     # 构建 lib/client.js（浏览器半边）与 lib/index.js（宿主半边）
npm test          # 92 个单测：文本策略 / SSE 分帧 / LRU / 宿主路由端到端 / 浏览器半边挂载 / 兼容性探针 / 底部输入框
npm run verify    # build + test + 产物契约校验（含 apply 真挂载、Config 禁令、inject 必须为空）
npm run compat    # 离线核对：本插件绑定的服务/槽位在**当前装的** dsh 里是否都还在（升级 dsh 后先跑这个）
```

- **无构建依赖**：`build.mjs` 是一个约 300 行的自写打包器（模块表 + 内部 require），配 `build-jsx.mjs`（JSX → `React.createElement`，支持元素/属性/表达式子节点/属性与子节点里嵌套的 JSX），只用 Node——不需要 esbuild、rolldown 或任何平台二进制（本机沙箱禁止子进程 spawn，esbuild 起不来）。
- 源码在 `src/`：`shared/`（两侧共用纯逻辑）、`host/`（SSE 路由与 LLM 调用）、`client/`（划选监听、引用 store、侧边栏页签）。
- 单改客户端：`node build.mjs` 后刷新页面；改宿主：重启 `dsh web`。
- `tools/try-jsx.mjs`、`tools/try-jsx-inline.mjs` 用来单独检查 JSX 转换结果（`node tools/try-jsx.mjs src/client/TranslatePane.jsx`）。
- `test/client.test.mjs` 用假 DOM + React 桩**真挂载打包后的客户端 bundle**（就是 DSH 模块系统 `__ModuleLoader__.load` 那条路径），断言页签类型、两个槽位、设置项、快捷键监听都注册成功，并把「侧边栏页签渲染出一条已完成译文」也断言掉——客户端 `apply` 抛错会拖垮整个客户端组合，和宿主半边那次事故同类，所以这里对着真产物测。**假 context 也实现了 `inject(deps, cb)`**：服务齐了就同步跑回调，缺了就记为 parked，所以"缺服务只降级"这条也有回归测试守着。
- `tools/check-dsh-compat.mjs` 是**升级 dsh 前的离线绊线**：它从构建产物里读出本插件绑定的每个服务名与槽位名，再去已安装的 `@deepseek-ai/*` 的 js/d.ts 里找同名字符串。命中不代表一定没错，但**一个名字彻底消失 = 下次开机就是那块 `Failed to load plugins`**。`test/compat.test.mjs` 用 `settingsScope`（0.1.7 真删掉的那个）当标本，保证这条绊线不是橡皮图章。
- `tools/cdp-boot-probe.mjs` 用真 Chrome（CDP）回答最后一个问题：**页面到底起没起来**。判定标准是"输入框在、`#root` 有内容、body 里没有 `Failed to load plugins`"。起 headless Chrome 的完整命令见 `HANDOVER.md` §5。
- `tools/cdp-composer-flow.mjs`（beta 专属）：空面板也贴底 → 打字 → **刷新后草稿还在** → 真 Enter → 卡片出中文 → 输入框清空。截图落 .evidence/h0-empty.png / h1-composer.png / h2-committed.png。
- `tools/cdp-full-flow.mjs` / cdp-dump.mjs / cdp-dig.mjs / cdp-surface-audit.mjs：端到端取证、DOM 大盘点、右栏结构深挖、划选命中率量化。

## 兼容性

- 实测环境：DSH **`0.1.7-rc.2`**（本机 `dsh --version`），端到端实测通过；客户端按 `dsh.client.platform = web` 由 DSH 客户端模块图装载。依赖面与各组件版本见上文 §「依赖与版本」。
- 只用公开扩展点：`slots`（`inject` / `register`）、`sidebarRight` / `sidebarRightTabs`（两段式页签注册）、`settings.general.item` 设置行、`uiSession.adapter.current`（当前会话作用域）、`uiConversation`（`chat` target 的 `legacy` 投影）、`ctx.llm.stream`、`ctx.webServer.register` / `tapIndex`、`ctx.systemPrompt.section`。
- **没有任何硬依赖**：`inject` 是空数组，所有服务都在各自的 `ctx.inject` 子 fiber 里等。服务缺失只会让那一项能力停摆，绝不会让整个 Web UI 起不来（见 §「已知坑与排查」0）。
- 右侧边栏不可用时不会报错：译文退化为一个固定浮层卡片，功能仍可用。
- 配置校验不走加载器的 schema（见上文），因此插件配置键由本插件自己把关；profile 里写错键会在 `apply()` 阶段抛错。
