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
> **动手改交互前先读 §「已知坑与排查」**：那里按症状记录了 6 个已经踩过、且回归测试正在守着的坑（座位 key 必须用定义 `id` / capture 阶段 `mousedown` 会吃掉自己的 click / 重试计数器与请求函数同名 / 空白面板=渲染抛错被退位 / hooks 阶段抛错拦不住 / 数据 prop 不能叫 `ref`），以及 `?dsht-debug=1` 两块诊断面板的判读表。

## 安装

```powershell
# 本地目录（本机开发方式）
dsh plugin --profile web add link:<克隆到本地的路径>

# 或从 npm / git 安装
dsh plugin --profile web add dsh-translator
dsh plugin --profile web add github:<owner>/dsh-translator
```

然后**重启 `dsh web`**（宿主半边改动必须重启；之后只改客户端半边刷新页面即可）。

卸载：

```powershell
dsh plugin --profile web remove dsh-translator
```

## 使用

1. 在对话里**划选**想看的英文（≥ 8 个字符）。
2. 松手后出现「译」胶囊按钮 → 点击。右侧边栏自动展开并切到「翻译」页签，译文逐字出现。
3. 继续划选 → 新引用加到列表顶部；同一段内容再引用一次会直接命中缓存，不再请求模型。

其他入口：

| 方式 | 说明 |
|---|---|
| 拖拽「译」按钮到面板 | 与点击等价，拖到面板任意位置松手即翻译 |
| 把任意文字拖进「翻译」页签 | 页签整体是拖放区，拖进去的内容直接翻译 |
| `Ctrl+Shift+T` | 翻译当前选区；没有选区时只打开页签（快捷键可在设置里改） |
| 设置 → 通用 → 划选翻译 | 目标语言、代码块跳过、Think/正文开关、快捷键 |

页签里的每张卡片都可以：复制译文 / 复制原文 / 重新翻译 / 取消 / 删除。顶部工具条可切换目标语言与清空列表。

## 行为细节

- **只翻译用户引用的内容**——不自动翻译整轮回答，也不改动模型输出。
- **划选中文不会打扰你**：判定「已是中文」时只提示，不发请求。
- **代码不送翻译**：命令行、路径、URL、行内参数与围栏代码块会被替换成 `⟪code⟫` 占位符，模型看到的是占位符，显示时原位还原成原文。
- **长文本分批**：超过约 400 字的引用按段落/句子切成多段串行翻译，按序拼接。
- **失败降级**：认证/额度/超时/空回答都会在卡片上显示错误码与原因，可单独重试；联网失败会自动退避重试 2 次（仅在尚无译文时）。
- **每会话独立**：引用列表按 Session 存在浏览器本地，切换会话各自一份，刷新页面后仍在。

## 已知坑与排查（改交互前先读）

### 0. 侧边栏座位必须按定义 `id` 注册，不是按 `kind`

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

### 1. 不要在 capture 阶段的 `mousedown` 里抹掉自己的按钮

浮标按钮曾经**一点就"没反应"**。原因不是没绑定 `click`，而是事件的先后顺序：`document` 上捕获阶段的 `mousedown` 先把候选清空并重渲染，按钮在 `mousedown` 阶段就被卸载，浏览器于是不再向它派发 `click` —— 按钮看上去"点不动"。

**规则**：任何"按下即收起"的逻辑（浮标、菜单、popover）都必须先判断事件目标是否落在自家 UI（`[data-dsh-translator-ui]`）里；落在里面就**只记录手势、不收起**。这条判断被抽成纯函数 `handleMouseDown(event, current, now)`（`src/client/watch.js`），并由 `test/client.test.mjs` 里的回归测试直接守着——包括"按下自家按钮必须返回 `dismissed: false`"这一条。

配套：浮标的位置在**渲染期**算（`pillAnchorFor`，纯函数、只读视口尺寸），不放 `useEffect`。放 effect 会让首帧返回 `null`，任何需要拿到按钮元素的消费者都得等第二次渲染。

### 2. 传输层：重试循环的计数器不能和请求函数同名

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

### 3. 排查"点了没反应 / 卡在翻译中"

1. 浏览器控制台看 `[dsh-translator]` 前缀的行：`sidebarRight` 不可用、内容无需翻译、渲染失败都会打日志；`TypeError` 之类也会以红字出现（就是第 2 类）。
2. 用 `Ctrl+Shift+T` 走同一条 `commitSelection`：快捷键正常而按钮异常 → 属于第 1 类事件竞态；两者都不动 → 看第 3 条。
3. 在页面上直接跑一次真请求（不经插件 UI），确认宿主与模型链路：
   ```powershell
   curl.exe -N -X POST http://127.0.0.1:3080/dsh-translator/translate `
     -H 'content-type: application/json' -H 'host: 127.0.0.1:3080' `
     -d '{"text":"Let me check the repository layout first."}'
   ```
   有 `start` → 多个 `delta` → `done` 且是中文 ⇒ 宿主正常，问题在浏览器半边（看第 1、2 条）；否则看 `GET /dsh-translator/health` 的 `llm`/`route` 字段。
4. 右侧边栏不可用时，插件会退化成浮层卡片并在卡片上写明原因，**不会出现"点了什么都没有"**。

### 4. `?dsht-debug=1`：让页面自己交代状态

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
| `tab id / kind` + `seat keys` | 定义 `id`、`openTab` 用的 `kind`、两个座位注册的 `key`（必须 `key === id`，见第 0 条） |
| `slots.snapshot` / `slot.title` / `tab types` | **官方运行时诊断**：座位里到底有没有我的条目、是否 `inactive`（=渲染抛错被退位）、已注册的 `id/kind` 对 |
| `refs` | 引用列表的真实状态（`done:12字` 这种），区分"没建引用"和"建了没显示" |
| `render errors` | 渲染失败记录（由 `useSafeSnapshot` 与 `recordRenderFailure` 写入） |
| `openTab` / `pane render` | 直接调用一次 `openTab(kind)` 与面板组件，看谁抛错 |

判读口诀：**空白面板 = 座位条目被退位（组件渲染抛错，DOM 里只剩 `div[data-slot-error]`）；那句"这类内容还没有可用的查看方式。" = 座位 key 和定义 `id` 不一致**（见第 0 条）。

### 5. 绝对不要把数据 prop 命名成 `ref`（组件会拿到 `undefined`）

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
npm test          # 58 个单测：文本策略 / SSE 分帧 / LRU / 宿主路由端到端 / 浏览器半边挂载
npm run verify    # build + test + 产物契约校验（含 apply 真挂载、Config 禁令）
```

- **无构建依赖**：`build.mjs` 是一个约 300 行的自写打包器（模块表 + 内部 require），配 `build-jsx.mjs`（JSX → `React.createElement`，支持元素/属性/表达式子节点/属性与子节点里嵌套的 JSX），只用 Node——不需要 esbuild、rolldown 或任何平台二进制（本机沙箱禁止子进程 spawn，esbuild 起不来）。
- 源码在 `src/`：`shared/`（两侧共用纯逻辑）、`host/`（SSE 路由与 LLM 调用）、`client/`（划选监听、引用 store、侧边栏页签）。
- 单改客户端：`node build.mjs` 后刷新页面；改宿主：重启 `dsh web`。
- `tools/try-jsx.mjs`、`tools/try-jsx-inline.mjs` 用来单独检查 JSX 转换结果（`node tools/try-jsx.mjs src/client/TranslatePane.jsx`）。
- `test/client.test.mjs` 用假 DOM + React 桩**真挂载打包后的客户端 bundle**（就是 DSH 模块系统 `__ModuleLoader__.load` 那条路径），断言页签类型、两个槽位、设置项、快捷键监听都注册成功，并把「侧边栏页签渲染出一条已完成译文」也断言掉——客户端 `apply` 抛错会拖垮整个客户端组合，和宿主半边那次事故同类，所以这里对着真产物测。

## 兼容性

- 目标：DSH `0.1.5-rc.2`（本机验证版本），客户端按 `dsh.client.platform = web` 由 DSH 客户端模块图装载。
- 只用公开扩展点：`slots`、`sidebarRight` / `sidebarRightTabs`（两段式页签注册）、`sessions`、`uiConversation`（`chat` target 的 `legacy` 投影）、`ctx.llm.stream`、`ctx.webServer.register`、`ctx.systemPrompt.section`。
- 右侧边栏不可用时不会报错：译文退化为一个固定浮层卡片，功能仍可用。
- 配置校验不走加载器的 schema（见上文），因此插件配置键由本插件自己把关；profile 里写错键会在 `apply()` 阶段抛错。
