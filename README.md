# dsh-translator

DSH Web GUI 的**划选翻译**插件：在对话里用鼠标划选一段外文（Think 推理行、中间步骤正文、任意片段），点出现的「译」按钮，译文就在**右侧边栏的「翻译」页签**里由 AI 流式产出。

**纯显示层**：译文只存在于浏览器与本插件的缓存里，不写入会话日志、不进入模型上下文、不影响回放与缓存命中。

**当前版本 `0.2.0`**：工具条是翻译软件那套 `源语言 → 目标语言`（源语言默认**自动识别**，目标语言默认中文），带 **8 个翻译挡位**（通用 / 学术 / 技术 / 文学 / 口语 / 直译 / 提示词 / 自定义），页签最底部有一个输入框可以直接打字或粘贴来翻译。

```
划选 → 「译」按钮（或拖到面板 / Ctrl+Shift+T / 底部输入框）
      → 右侧边栏「翻译」页签 → 官方 LLM (ctx.llm.stream) 流式中文译文
```

> ⚠️ **从 0.1.0 升到 0.2.0 必须重启一次 `dsh web`。** 语言对、挡位、自定义要求都要经过宿主半边组装提示词，而宿主是**启动时载入内存**的：只刷新页面的情况下，客户端发过去的新字段会被旧宿主静默忽略（页面一切正常，译文却还是旧挡位的风格）。详见 §「版本与升级」。

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

### 版本与升级

| 版本 | 内容 | 升级动作 |
|---|---|---|
| **`0.2.0`** | 语言对 `源语言 → 目标语言` + `⇄` 交换、源语言**自动识别**、**8 个翻译挡位**、底部输入框、UI 细节一轮 | **重启 `dsh web`**（宿主半边组装提示词）；客户端半边刷新页面即可 |
| `0.1.0` | 划选 → 「译」→ 侧栏流式译文；按会话隔离的引用列表；设置行与快捷键 | 首次安装后重启 `dsh web` |

**为什么升级一定要重启宿主**：客户端每次刷新都取新产物（profile 是 `link:` 到工作树），但宿主的 `lib/index.js` 进了进程内存就不再重读。旧宿主只认 `text/kind/lang/route`，会**静默丢掉**请求里的 `mode` / `source` / `instruction` —— 症状是"换成学术挡位了，译文风格一点没变"，而且**不报任何错**。这正是本仓库为此加了一条发布闸门的原因（`tools/host-prompt-probe.mjs`：直接问**构建产物**到底组装出什么提示词）。

`0.2.0` 的行为变化（值得知道的几条）：

1. **繁体中文文本 + 目标简体中文** 现在会真的送翻译（繁→简是正当需求），`0.1.0` 把它当成"已经是中文"拒掉了。
2. **日文**过去因为汉字占多数被判成"已是中文"而拒绝，现在按假名（以及新字体专用汉字）判定，正常翻译。
3. 目标语言不再只有中文：换成别的目标语言后，"同语言就不译"的判定跟着目标语言走（目标日语时，日语文本才是被拒的那个）。
4. **判定更保守了**：西里尔/阿拉伯/天城文只报告猜测、拉丁语言需要"独家虚词"才算确定。代价是偶尔会多译一次（比如把俄语文本"译"成俄语），收益是不会再有"按不动的按钮"。
5. **整段都是代码时不再调用模型**（以前会白花一次调用并把原文原样返回）；模型漏掉占位符时，被漏掉的代码段会补在译文末尾，而不是从面板上消失。

发布前做过一轮**整体复查**（三路独立审查：共享层 / 客户端 / 宿主与适配），修掉的真问题都记在 `HANDOVER.md` §12，其中三条值得知道：

- **`ctx.llm.listModels()` 在 0.1.7-rc.2 是 `Promise`**，而旧代码把它当数组用：`Array.isArray(promise)` 永远为假 → **每一次"这个模型路由可用吗"的检查都被静默跳过**，回退模型（`deepseek-v4-flash`，这个模型名在本机适配器里**根本不存在**）也就永远轮不到。现在会真的 await 目录、按目录回退到 `deepseek-flash`。
- **部署配置写错不再能把整个 Web UI 弄死**：`apply()` 抛错在 0.1.7 里是 plugin tree 加载失败（= 开机画面）。现在坏配置会**大声记一条警告并退回默认值**，插件照常工作（`resolveConfig` 仍然是个会抛错的纯校验器，可以直接断言）。
- **回复流的错误不再可能终结宿主进程**：请求超大时销毁 socket 会触发 `error` 事件，之前没有监听者（Node 里无监听的 `error` 事件会**杀掉整个进程**）；现在会清掉监听、并给响应挂一个 error 处理。

### 版本兼容性提示

- **DSH `0.1.7-rc.2`**：本版适配并端到端实测通过（划选 → 译 → 右侧栏出中文译文，0 报错；引用列表按 Session 命名空间落盘）。插件只用公开扩展点（`webServer.register` / `tapIndex`、`sidebarRight` 座位、`sidebarRightTabs.register`、`settings.general.item`、`ctx.llm.stream`、`uiSession.adapter.current`）。
- **DSH `0.1.6-*`**：仍可用。0.1.6 没有 `uiSession.adapter`，会话命名空间会退回 `default`（多会话共用一份引用列表），其余功能不受影响——因为取服务失败只会让那一项能力停摆。
- **DSH `0.2+`**：`peerDependencies["@deepseek-ai/dsh"]` 不满足 ⇒ **DSH 会在启动时明确拒绝加载本插件**（不会把 GUI 弄崩）。升级前先跑 `npm run compat`。
- **某次 DSH 升级后整个 Web UI 卡在 `Failed to load plugins`**：这是 DSH 客户端启动的判定方式导致的（任何一个 client entry 不是 active 就抛），排查入口见 §「已知坑与排查」0；预防手段是 `npm run compat`。
- **Node `< 22`**：`engines` 不满足。构建期（`npm run build`）用到较新的 ESM/正则特性，请用 Node 22+。
- **升级 DSH 后的三步**（顺序别换）：
  ```powershell
  npm run compat     # 1) 离线静态核对：服务/槽位/客户端 bundle 是否都还在（147 个测试里也有它）
  npm run verify     # 2) 重建 + 147 个测试 + 产物契约 + 宿主提示词探针
  node tools\cdp-boot-probe.mjs   # 3) 真浏览器：页面还起不起得来（需 9222 上的 headless Chrome）
  ```



1. 在对话里**划选**想看的英文（≥ 8 个字符）。
2. 松手后出现「译」胶囊按钮 → 点击。右侧边栏自动展开并切到「翻译」页签，译文逐字出现。
3. 继续划选 → 新引用加到列表顶部；同一段内容再引用一次会直接命中缓存，不再请求模型。

工具条左上角是翻译软件那套 **`源语言 → 目标语言`**：源语言默认 `自动检测`，目标语言默认 `简体中文`，中间的 `⇄` 交换两端，右边是**翻译挡位**（通用 / 学术 / 技术 / 文学 / 口语 / 直译 / 提示词 / 自定义）。

其他入口：

| 方式 | 说明 |
|---|---|
| 拖拽「译」按钮到面板 | 与点击等价，拖到面板任意位置松手即翻译 |
| 把任意文字拖进「翻译」页签 | 页签整体是拖放区，拖进去的内容直接翻译 |
| **页签最底部的输入框** | 打字或粘贴 → `Enter` 当新引用送去翻译；`Shift+Enter` 换行。见下节 |
| `Ctrl+Shift+T` | 翻译当前选区；没有选区时只打开页签（快捷键可在设置里改） |
| 设置 → 通用 → 划选翻译 | 语言对、翻译挡位、自定义要求、代码块跳过、Think/正文开关、快捷键 |

页签里的每张卡片都可以：复制译文 / 复制原文 / 重新翻译 / 取消 / 删除，并在元信息里写明**自己**是在哪个语言对、哪个挡位下译出来的（`English → 简体中文 · 学术`）。

## 页签最底部的输入框

「翻译」页签的**最底部**有一个输入框，用来看你说的这种情况：手里已经有一段文字（剪贴板里的、别处复制来的、自己想写的），不想为了翻译它先去对话里把它造出来再划选。

| 操作 | 结果 |
|---|---|
| `Enter` | 把框里的内容当作**一条新引用**，走完全相同的翻译链路（分块、代码遮蔽、流式、缓存、卡片操作全都一样），卡片来源标记为「手动输入」 |
| `Shift+Enter` | 换行，不提交 |
| 左侧「翻译」按钮 | 与 `Enter` 等价（框空时变暗但仍可见） |
| 把文字**拖进输入框** | 暂存进输入框等你编辑，**不会**直接翻译（拖到面板其它地方仍然直接翻译） |
| 框里是中文 / 只有空白 | 不提交，提示一下。空白是无操作 |
| 输入法选词回车 | 不提交（`composing` 期间不认 Enter） |

> **按钮为什么在左边？** 不是审美选择，是被挡出来的。本机装了 `dsh-whale-widget`（小鲸鱼装饰，`position:fixed`、`z-index:9999`、`pointer-events:none`），它的绘制区域正好压住右侧栏的**右下角**——也就是发送按钮的常规位置。因为它是 `pointer-events:none`，点击测试照样命中按钮、**什么错都不报**：按钮只是被**画在了下面**，看不见。
>
> 靠提高本元素的 `z-index` 解决不了：面板位于 ui-sidebar-right 的 `_tabCell_*` 之下，那是一个 `static` 但带 `z-index:10` 的 flex/grid 项，**本身就是一个 stacking context**，会把我们的层级封在它下面。只有把控件移出被遮挡的角落才有效。如果你把小鲸鱼挪走/关掉，说一声就把按钮放回右边常规位置。

**「输入暂存」**：框里的内容按会话存在浏览器本地（`dsh-translator:draft:` 前缀 + 会话 id），每敲一个字就存一次。**刷新页面或切走再切回来，没提交的字还在**；成功提交后该条暂存被清掉（提交失败则保留，不让你丢字）。

**它不是聊天框，这点是故意的。** 本插件的硬约束是"纯显示层"：它收集和显示的任何东西都不进会话日志、不进模型上下文。一个真聊天框会直接破坏这条。所以这个框干的事和浮动「译」按钮**完全一样**，只是入口换成了"我自己打"；它没有给模型开任何新的对话通道。

要真正做聊天，得先决定要不要放弃"纯显示层"这条约束——那是另一个决定，不是本插件的范围。

## 语言对 x→y · 自动识别源语言 · 翻译挡位

### 1. 工具条改成 `源语言 → 目标语言`

| 控件 | 行为 |
|---|---|
| 源语言下拉 | `自动检测`（默认）+ 15 种语言；选具体语言 = 告诉模型源文本是什么语言，同时也**取消**"同语言就不译"的判定 |
| 目标语言下拉 | 15 种语言，默认 `简体中文` |
| `⇄` 交换 | 源已指定 → 两端对调；源是 `自动检测` → 源钉成当前目标，目标改成**识别出来的语言**（识别不出则回落 `English`，再不行 `简体中文`）。也就是说"中文 ⇄ 英文"这个来回只需要一次点击 |
| 挡位下拉 | 见下节 |

**语言对永远不会两端相同**：某一侧被选成和另一侧一样时，另一侧会自动翻到它原来的值（没有可恢复的值时走上面的回落链）。否则这个组合会变成"什么都不译"的死状态，用户还不知道为什么。

### 2. 自动识别源语言

识别是**本地纯函数**（`src/shared/select.js` 的 `detectLanguage`），不发请求、不调模型：

| 顺序 | 依据 | 例子 |
|---|---|---|
| 1 | 假名 → 日语 | `この関数を確認してください。` |
| 2 | 谚文 → 韩语 | `이 함수를 확인해 주세요.` |
| 3 | 汉字（相对拉丁字母）占优 → 中文；繁简高频字投票决定 `zh-CN` / `zh-TW` | `這個問題我們會…` → `zh-TW` |
| 4 | 西里尔 / 阿拉伯 / 泰文 / 天城文 | `Проверь структуру…` → `ru` |
| 5 | 拉丁字母：30–60 个高频虚词投票 + 排他变音符（`ñ¿¡`→es、`ß`→de、`ãõ`→pt、`çœ`→fr、`ăđơư`→vi） | `¿Dónde está el archivo?` → `es` |
| 6 | 以上都不成立（太短、纯符号、没有证据） | `Kubernetes deployment strategy` → 未知 |

**铁律：识别不出、或只有一点点证据时，绝不拒绝翻译。** 只有 `certain` 的识别结果才参与"这段已经是目标语言了"的判定；多花一次便宜调用永远好过一个按不动的按钮。所以：

- 中文文本 + 目标中文 → 拒绝（和以前一样），但提示语现在按**真实目标语言**生成（目标日语时是「已是日本語」）。
- 繁体文本 + 目标简体 → **真的送翻译**（繁→简是正当需求，不再被当成"已是中文"）。
- 日文过去会被当成中文而拒绝（汉字占多数），现在走假名判定；连**只有汉字**的日文（`確認済`）也认得出来（那些是新字体专用字，两种中文都不写）。反过来，纯汉字的短片段（`你好`）只是"猜"，不会被拿来拒绝。
- **一个书写系统不等于一种语言。** 西里尔/阿拉伯/天城文各自覆盖多种语言（俄/乌克兰、阿拉伯/波斯/乌尔都、印地/马拉地……），所以那几支只**报告猜测**（`certain: false`），永不参与拒绝：一个乌克兰语选区不会被当成俄语而拒掉。泰文与谚文确实各只有一种候选语言，保持 `certain`。
- 拉丁字母的票数需要**领先 + 至少一个"只有它会用"的虚词**：西/葡共用 `o`/`se`/`que`/`a`/`de`，意大利语和英语共用 `in`/`a`，所以"3 票领先 2 票"其实是掷硬币——掷硬币说"已经是西班牙语了"就会把葡萄牙语拒掉。带决定性变音符（`¿ñ` / `ß` / `ãõ` / `çœ` / `ăđơư`）时不需要投票。
- **钉住的源语言优先，但被文本确定反驳时以文本为准。** 用过 `⇄` 之后源语言会被钉成"你原来在译入的语言"，此时再划选你原来在读的那种语言，就会变成"把英文从中文译成英文"——白花一次调用还返回原句。文本确定的语言赢；用户的钉子只在文本没把握时生效。

识别结果写在**卡片自己**的元信息里：`English → 简体中文`（不确定时是 `English?`，tooltip 会说明）。

### 3. 翻译挡位（8 档）

挡位是加在系统提示里的**一行风格要求**，规则（逐字输出、术语原样、占位符原样、不许回答原文……）永远保留，所以新挡位不可能把某条规则挤掉：

| 挡位 | 适用 |
|---|---|
| **通用** | 默认：通顺自然，保留作者语气 |
| **学术** | 论文与技术文档：术语精确一致、书面语、保留 may/suggest/likely 这类限定词与引用数字 |
| **技术** | 代码上下文：标识符、API、命令、路径、报错原文全保留，只译散文 |
| **文学** | 叙述与修辞：保留语气、节奏、意象，允许为通顺重组句子，不把隐喻解释成白话 |
| **口语** | 聊天对话：保留缩略、俚语、语气词，不书面化 |
| **直译** | 逐句对照：贴着原文语序与断句，用于核对原意，不允许"顺手润色" |
| **提示词** | AI 提示词：角色标记、章节标题、占位符、格式原样，不弱化指令 |
| **自定义** | 用「设置 → 通用 → 自定义要求」里那段话（≤400 字）；留空时按「通用」处理并在 tooltip 里说明 |

换挡会**把现有卡片按新挡位重译一遍**（同一张卡片，不复制；页内缓存与宿主缓存都按 `目标语言 + 挡位 + 源语言` 分键，所以切回旧挡位是缓存命中、零成本——这正是"拿两个挡位对比同一段文字"该有的花费）。

有一条例外，而且是刻意的：**当某张卡片的文本本身就是新目标语言时，它不会被重译。** 例如英文卡片在你点 `⇄` 把目标切成英文之后不会去"英译英"——那是一次白花的调用，换回来还是同一句话。这张卡片保留它自己的语言对，卡片上的 `English → 简体中文` 就是它诚实的档案。想手动重译某张卡片，卡片上的「重新翻译」按它自己的语言对再跑一次。

### 4. 缓存维度的变化

`translationKey(text, target, route, {mode, source, style})`：多了挡位、源语言提示，以及自定义挡位那段要求本身（改了要求必须让旧答案失效，否则"我改了要求却没反应"）。

## UI 细节

整块面板做过一轮样式与信息层级，改的是"读起来累"的地方，不是加功能：

| 位置 | 改了什么 | 为什么 |
|---|---|---|
| 工具条 | 目标语言下拉 → **`源语言 → 目标语言` + `⇄` + 挡位**；语言下拉自绘箭头；`N 条引用` 做成胶囊；`BETA` 标签降为弱色 | 一行里三种不同视觉重量，眼睛不知道该看哪儿；一个"目标语言"下拉也没说清另一端是什么 |
| 卡片元信息 | 加 `English → 简体中文 · 学术` 胶囊，排在来源标签之后 | 换过挡位/语言之后，只有卡片自己知道它是在哪套设置下译出来的 |
| 空状态 | 加了 `译` 图标位 + 主副文案分级 + `kbd` 样式；文案从「划选英文」改成「划选外文」 | 原来是一堆同样灰的小字，没有视觉落点；源语言现在是任意语言 |
| 拖放提示 | 从常驻虚线框 → 只有真正拖拽时才出现虚线高亮 | 常驻虚线框和输入框抢"这里可以输入"的语义 |
| 卡片 | 原文加左侧引用竖线；译文提亮；操作行加分隔线；悬停描边 | 原文/译文原来只靠明暗区分，一眼分不清哪句是哪句 |
| 卡片元信息 | `provider/model` → 只显示 `model`，完整路由进 tooltip | 每张卡片都重复同一个最长的串，压过了真正要扫的状态 |
| 发送按钮 | 禁用态从"透明 + 40% 不透明"改成"有底色 + 60%" | 深色底上它等于隐形，整条输入区读起来"只有框没有动作" |
| 样式表 | 全表统一走 `--dsht-*` 令牌（映射到 DSH 的 `--dsw-alias-*`），加了 `prefers-reduced-motion` | 颜色散落在各处，改主题会漏 |

> UI 迭代的快速通道：`node tools\cdp-pane-shot.mjs`（可加 `--clear` 看空态、`--draft "文字"` 看暂存态）直接导航到页签并截图，不用跑那套会真的调用模型的端到端流程。它截图前会**把鼠标移开侧栏**：ui-sidebar-right 有个 hover 气泡（`position:fixed`、`z-index:100`）正好落在工具条右端，截图里会看到 `收起侧边栏 Ctrl+Shift+B` 压在 `N 条引用`/`清空` 上——那**不是**本插件的布局 bug，鼠标一离开就没了。

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
        model: deepseek-flash           # 可选；不填则跟随部署默认模型
        targetLanguage: zh-CN           # zh-TW / en / ja / ko / es / fr / de / ru / pt / it / vi / th / ar / hi
        sourceLanguage: auto            # auto（默认，自动识别）或上表任一语言码；与 targetLanguage 不能相同
        mode: general                   # general / academic / technical / literary / casual / literal / prompt / custom
        customInstruction: ''           # mode: custom 时的附加要求（≤400 字，换行会折叠成空格）
        timeoutMs: 30000                # 单次翻译调用超时
        maxOutputTokens: 4096           # 单次翻译输出上限
        cacheSize: 500                  # 宿主侧译文缓存条数
        reasoningEffort: ''             # 可选；透传给适配器（不填=由模型决定）
        verbose: false                  # 每次翻译打一行日志
```

不写 `provider`/`model` 时的路由优先级：**单次请求覆盖 → 配置 → 部署默认模型（`agent-default-model`）→ `deepseek-flash` → 该 provider 目录里的第一个模型**。每个候选都会先向适配器注册表（`ctx.llm.listModels`，**异步**）确认可用，不可用就顺延，所以一个过期的模型名只会让插件降级，不会让它整体失效。

> **翻译用哪个模型**：解析出来的那一条路由，也就是"部署默认模型"，**不跟随会话里临时切换的模型**（会话级选择是 Agent 作用域的，宿主路由拿不到）。卡片上会显示实际使用的模型名，便于对账。

`sourceLanguage` / `mode` / `customInstruction` 是**部署级默认值**，页面上用户自己的设置优先；配 `sourceLanguage` 与 `targetLanguage` 相同时 `resolveConfig` 会拒绝它（那种组合等于什么都不译）：`apply` 记一条警告并退回默认值，**不会**因此把 Web UI 弄死。`mode: custom` + `customInstruction` 可以让整个机房默认用某套风格要求。

### 为什么没有 `Config` 导出（改这里之前请先读）

**不要给这个插件加回 `Config` 导出。** cordis 校验配置走的是 standard-schema 契约 —— `runtime.Config["~standard"].validate(rawConfig)`（见 `@deepseek-ai/cordis` 的 `resolveConfig`）。把一个只实现 `.default()/.min()/.max()` 的 schemastery 风格对象挂到 `Config` 上，加载器在 `~standard` 处读到 `undefined`，报 `Cannot read properties of undefined (reading 'validate')`，并且**整个 plugin tree 加载失败、`dsh web` 起不来**——挂掉的不是这一个插件，是所有插件。

所以本插件**不导出 `Config`**，校验放在 `apply()` 里由 `resolveConfig()` 完成：没有 schema 时加载器把原始配置透传，坏配置仍在启动时大声抛错，但影响被限制在本插件内。`npm run verify` 有一条断言专门守着它（`host must not export a Config schema`），加回来就会构建失败。

### 用户级（浏览器 localStorage）

语言对（源 + 目标）、翻译挡位、自定义要求、代码块跳过、Think/正文开关、快捷键存在浏览器本地（`dsh-translator:settings`），设置面板与工具条改的是同一份；不写回 `settings.yaml`。引用列表与输入框草稿按会话分键存（`dsh-translator:refs:<会话>` / `dsh-translator:draft:<会话>`）；旧版本写下的引用缺少挡位/源语言字段，读出来按默认值补齐，**不会因为升级丢卡片**。

## HTTP 面

| 路由 | 说明 |
|---|---|
| `POST /dsh-translator/translate` | body `{text, kind?, lang?, source?, mode?, instruction?, route?, sessionId?}`，返回 SSE：`start` / `delta` / `done` / `error` |
| `GET /dsh-translator/health` | `{ok, llm, route}`，可用来确认插件与模型路由是否就绪 |

两条路由都只接受 loopback `Host`（`127.0.0.1` / `localhost` / `[::1]`），其余一律 403；非 POST 405；body 上限 32 KB。

`lang` 是**目标**语言；`source` 是源语言（`"auto"` 或语言码），`mode` 是挡位 id，`instruction` 只对 `custom` 挡位有意义。后三个都在宿主侧**按本插件自己的表再消毒一次**：未知挡位回落 `general`，未知/缺省源语言等价于 `auto`（即"模型自己判断"），`instruction` 截到 400 字。所以页面跑着旧产物、或者有人手写请求，都不可能把任意字符串塞进提示词的一行里。

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
npm test          # 147 个单测：文本策略与识别 / 挡位与提示词 / 语言对 / SSE 分帧 / LRU / 宿主路由端到端 / 浏览器半边挂载 / 兼容性探针 / 底部输入框 / 语言对与挡位
npm run verify    # build + test + 产物契约 + 宿主提示词探针（含 apply 真挂载、Config 禁令、inject 必须为空）
npm run compat    # 离线核对：本插件绑定的服务/槽位在**当前装的** dsh 里是否都还在（升级 dsh 后先跑这个）
```

- **无构建依赖**：`build.mjs` 是一个约 300 行的自写打包器（模块表 + 内部 require），配 `build-jsx.mjs`（JSX → `React.createElement`，支持元素/属性/表达式子节点/属性与子节点里嵌套的 JSX），只用 Node——不需要 esbuild、rolldown 或任何平台二进制（本机沙箱禁止子进程 spawn，esbuild 起不来）。
- 源码在 `src/`：`shared/`（两侧共用纯逻辑）、`host/`（SSE 路由与 LLM 调用）、`client/`（划选监听、引用 store、侧边栏页签）。
- 单改客户端：`node build.mjs` 后刷新页面；改宿主：重启 `dsh web`。
- `tools/try-jsx.mjs`、`tools/try-jsx-inline.mjs` 用来单独检查 JSX 转换结果（`node tools/try-jsx.mjs src/client/TranslatePane.jsx`）。
- `test/client.test.mjs` 用假 DOM + React 桩**真挂载打包后的客户端 bundle**（就是 DSH 模块系统 `__ModuleLoader__.load` 那条路径），断言页签类型、两个槽位、设置项、快捷键监听都注册成功，并把「侧边栏页签渲染出一条已完成译文」也断言掉——客户端 `apply` 抛错会拖垮整个客户端组合，和宿主半边那次事故同类，所以这里对着真产物测。**假 context 也实现了 `inject(deps, cb)`**：服务齐了就同步跑回调，缺了就记为 parked，所以"缺服务只降级"这条也有回归测试守着。
- `tools/check-dsh-compat.mjs` 是**升级 dsh 前的离线绊线**：它从构建产物里读出本插件绑定的每个服务名与槽位名，再去已安装的 `@deepseek-ai/*` 的 js/d.ts 里找同名字符串。命中不代表一定没错，但**一个名字彻底消失 = 下次开机就是那块 `Failed to load plugins`**。`test/compat.test.mjs` 用 `settingsScope`（0.1.7 真删掉的那个）当标本，保证这条绊线不是橡皮图章。
- `tools/cdp-boot-probe.mjs` 用真 Chrome（CDP）回答最后一个问题：**页面到底起没起来**。判定标准是"输入框在、`#root` 有内容、body 里没有 `Failed to load plugins`"。起 headless Chrome 的完整命令见 `HANDOVER.md` §5。
- `tools/cdp-composer-flow.mjs`：空面板也贴底 → 打字 → **刷新后草稿还在** → 真 Enter → 卡片出中文 → 输入框清空 → **语言对是 x→y 且 `⇄` 语义正确** → **换挡后同一张卡片按新挡位重译、不复制、卡片写明挡位**。截图落 .evidence/h0-empty.png / h1-composer.png / h2-committed.png / h4-swapped.png / h5-gear.png / h3-list.png。它会真调用模型（约 5 次），跑一次几分钟。
- `tools/cdp-pane-shot.mjs`（**UI 迭代主力**）：只导航到「翻译」页签并截图，不调用模型。`--clear` 看空态，`--draft "文字"` 看暂存态。
- `tools/cdp-crop.mjs`：放大裁切任意区域（`<x> <y> <w> <h> [scale] [name]`）。1px 描边、对比度、"按钮到底在不在"这类问题，整屏截图会压没、DOM 命中测试会**给出错误答案**（见 §「UI 细节」里小鲸鱼那段）。
- `tools/cdp-full-flow.mjs` / cdp-dump.mjs / cdp-dig.mjs / cdp-surface-audit.mjs：端到端取证、DOM 大盘点、右栏结构深挖、划选命中率量化。

## 兼容性

- 实测环境：DSH **`0.1.7-rc.2`**（本机 `dsh --version`），端到端实测通过；客户端按 `dsh.client.platform = web` 由 DSH 客户端模块图装载。依赖面与各组件版本见上文 §「依赖与版本」。
- 只用公开扩展点：`slots`（`inject` / `register`）、`sidebarRight` / `sidebarRightTabs`（两段式页签注册）、`settings.general.item` 设置行、`uiSession.adapter.current`（当前会话作用域）、`uiConversation`（`chat` target 的 `legacy` 投影）、`ctx.llm.stream`、`ctx.webServer.register` / `tapIndex`、`ctx.systemPrompt.section`。
- **没有任何硬依赖**：`inject` 是空数组，所有服务都在各自的 `ctx.inject` 子 fiber 里等。服务缺失只会让那一项能力停摆，绝不会让整个 Web UI 起不来（见 §「已知坑与排查」0）。
- 右侧边栏不可用时不会报错：译文退化为一个固定浮层卡片，功能仍可用。
- 配置校验不走加载器的 schema（见上文），因此插件配置键由本插件自己把关；profile 里写错键会在 `apply()` 阶段抛错。
