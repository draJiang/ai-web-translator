# AI 网页阅读助手（AI Web Translator）

一个 Chrome 插件（Manifest V3）：用你自己配置的 AI 模型，直接在网页原地改写正文内容，**不修改页面布局**（原理类似沉浸式翻译，但只替换文本节点的内容，不插入新元素、不改变 DOM 结构），可随时一键还原。

**当前版本（v0.1）固定使用一个内置 Prompt**：把网页英文正文改写为 CEFR **B1** 难度，方便英语阅读练习——长句拆短、替换生僻词，保留的难词会在后面加简短英文释义。是否翻译成其它语言、或换成别的改写方式，由 Prompt 决定；本版本先把这一个场景做扎实，后续可以扩展成可切换的多个 Prompt（例如跨语言翻译）。

## 功能

- 一键处理整个页面，或右键菜单处理选中文本
- 只处理页面 `<main>` 标签内的正文（没有 `<main>` 的页面回退为整个 `<body>`），跳过导航栏、侧边栏、页脚等非正文区域
- 按滚动位置懒加载处理：打开时只处理当前可见内容，其余内容在**即将**滚入视口时才处理（默认提前 600px），不会一次性处理整页、不会浪费 API 调用
- 直接替换原始文本节点内容，不改变页面排版/结构
- 一键还原为原文；还原后会停止后续的懒加载处理
- 两种状态在工具栏图标上可见：原文状态为默认图标，译文（B1）状态图标右下角会多一个绿色对勾徽标，无需打开弹窗也能看出当前标签页处于哪种状态
- AI 服务商可配置，支持：
  - **OpenAI**（`api.openai.com/v1/chat/completions`）
  - **Anthropic Claude**（`api.anthropic.com/v1/messages`）
  - **Ollama**（Cloud 或本地，`POST /api/chat`），默认连接 `https://ollama.com`
  - **自定义**：任意兼容 OpenAI `/chat/completions` 协议的接口
- API Key 只存在浏览器本地（`chrome.storage.local`），不经过除你所选服务商之外的任何服务器

## 安装（开发模式）

1. 打开 Chrome，访问 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库目录
4. 点击工具栏里的插件图标 → 「AI 服务商设置」，填入 API Key 等信息后保存

## 使用

- 点击插件图标 → 「转为 B1 英文」，处理当前整个页面；再次点击变为「还原原文」
- 选中网页上的一段文字 → 右键 → 「转为 B1 英文（选中内容）」
- 右键页面空白处 → 「转为 B1 英文（整个页面）」

## Ollama Cloud 配置示例

在「AI 服务商设置」里选择 Ollama，Base URL 保持默认 `https://ollama.com`，填入你的 Ollama API Key。插件内部等价于：

```bash
curl https://ollama.com/api/chat \
  -H "Authorization: Bearer $OLLAMA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma4:31b",
    "messages": [{"role": "system", "content": "..."}, {"role": "user", "content": "..."}],
    "stream": false
  }'
```

若使用本地 Ollama，把 Base URL 改成 `http://localhost:11434`，一般无需 API Key。首次保存/测试时浏览器会弹出一次性的站点授权确认，这是 Chrome 扩展的最小权限机制，不是异常。

## 实现原理

1. `content/content-script.js` 用 `TreeWalker` 收集 `<main>`（没有则整个 `<body>`）里可见的文本节点（跳过 `script`/`style`/`input`/`code` 等），按共同的父元素分组成一个个「片段」。
2. 每个片段的父元素被注册进一个 `IntersectionObserver`，`rootMargin` 向下扩展 600px——也就是说片段一旦进入视口，或者还没进入但已经在"即将滚入视口"的缓冲区内，就会被标记为待处理。点击「转为 B1 英文」时不会立刻处理全文，只有当前视口 + 缓冲区内的片段会先被处理。
3. 待处理的片段按字符数/条数限制合并成批次，通过消息发给 `background/service-worker.js`。
4. Service worker 根据设置调用对应 AI 服务商，系统提示词固定为 `lib/prompts.js` 中的 B1 改写规则，要求模型返回与输入条数一致的 JSON 字符串数组。
5. Content script 按顺序把返回结果写回**同一个文本节点**的 `nodeValue`，同时记住原文，便于「还原」。因为只改文本内容、不改 DOM 结构，页面排版不受影响。
6. 用户继续往下滚动时，新进入缓冲区的片段会持续被观察到并加入处理队列，直到整页处理完，或用户点击「还原原文」（还原会断开 observer、清空队列，并让任何仍在返回路上的旧请求结果作废，避免还原后又被写回）。
7. 每次状态切换（开启/还原）content script 都会给 background 发一条 `STATE_CHANGED` 消息，background 用 `chrome.action.setIcon` 按 `tabId` 切换该标签页的工具栏图标；标签页开始加载新文档时图标会自动重置为默认状态。

### 已知局限

- 处理是按 DOM 文本节点分批进行的，同一句话如果被内联标签（如 `<b>`/`<a>`）拆成多个文本节点，AI 只能分别处理每个片段，可能损失句子级别的整体重写效果，比逐段处理连续文章的效果要弱一些。
- 懒加载依赖 `IntersectionObserver`，对于高度虚拟滚动（内容随滚动动态增删 DOM）的页面，效果可能不如普通静态长文页面稳定。
- 目前只有 B1 英文改写这一个固定场景；多语言翻译、可自定义 Prompt 等留作后续迭代。

## 目录结构

```
manifest.json
background/service-worker.js   # 消息路由 + 调用 AI 服务商 + 右键菜单
content/content-script.js      # 收集文本节点、写回结果、还原
content/content-style.css      # 页面右下角的状态提示样式
lib/providers.js               # 各 AI 服务商的请求实现
lib/prompts.js                 # 固定的 B1 改写系统提示词
lib/storage.js                 # 设置的读写（chrome.storage.local）
popup/                         # 工具栏弹出窗口
options/                       # 设置页
icons/                         # 插件图标（默认 + 译文状态的 -active 变体）
```

## License

MIT
