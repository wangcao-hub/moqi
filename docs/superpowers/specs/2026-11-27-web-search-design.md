# 联网搜索：不开浏览器，在后台搜和读网页

> 2026-11-27 定稿。实现以代码和测试为准。随 moqi 0.9.0 发布。

## 1. 起因

- moqi 现在上网查东西只能用浏览器（Playwright MCP）：打开搜索页、再用 `browser_evaluate` 读页面。`browser_evaluate` 会在网页里执行脚本，是危险动作；这一轮读过网页之后，即使用户放开过也要再问，所以每次搜索都要点确认。
- 一次搜索要占两三轮工具调用，6 轮很快用完。0.8.0 时 DeepSeek 在最后一轮吐出工具调用标记，就是这样触发的（0.8.1 已修）。
- 用户希望在后台搜索，设置里勾选、填 token 就能用。

和用户确认过的选择：

- 第一版接 DeepSeek 和百度，代码按"每家一个适配器"组织，以后可以再加。
- 除了搜索，也提供读网页正文。
- 模型接口是 `api.deepseek.com` 时默认开启，复用模型的 key；其他情况要用户自己打开。

## 2. 工具（`src/plugins/search.ts`）

新插件，只用 `fetch`，电脑和以后的手机都能跑。它提供两个只读工具。

### 2.1 `web_search`

- 参数：`query`（1 到 128 个字），`count`（可选，1 到 10，默认 6）。
- 返回一个列表，每条是标题、网址、日期（有的话）和一段摘要。DeepSeek 用返回的 `summary`（官方说明是给模型读的长摘要），百度用返回的 `content`。每条摘要截到 500 字，整个结果最多 5000 字左右。
- 没有结果时返回"没有搜到相关的网页"。

### 2.2 `web_read`

- 参数：`url`。
- 返回网页标题和正文，最多 8000 字；超出的部分截掉，末尾写"（后面还有，没有读完）"。
- 用 DeepSeek 时调它的 Fetch 接口（返回 Markdown）。用百度时由 moqi 自己下载网页，用新闻插件现有的 `articleText` 提取正文（见第 4 节的限制）。

### 2.3 两家的接口

- DeepSeek：`POST https://api.deepseek.com/v1/tools/search`，请求体 `{ query, count }`；`POST https://api.deepseek.com/v1/tools/fetch`，请求体 `{ url }`。头：`Authorization: Bearer <key>`。
- 百度：`POST https://qianfan.baidubce.com/v2/ai_search/web_search`，请求体 `{ messages: [{ role: "user", content: query }], search_source: "baidu_search_v2", resource_type_filter: [{ type: "web", top_k: count }] }`，结果在 `references`（`title`、`url`、`content`、`date`）。百度文档的说明和示例用的认证头不一样，两个都带上：`Authorization: Bearer <key>` 和 `X-Appbuilder-Authorization: Bearer <key>`。

### 2.4 出错

工具抛出一句中文原因，经 `callTool` 交给模型，由模型告诉用户：

- 401：搜索的 key 不对。
- 402：DeepSeek 余额不足。
- 429：搜索太频繁，或今天的免费额度用完了。
- DeepSeek Fetch 返回 404：这个网页读不出来。
- 其他：带上状态码。

### 2.5 属性

- `effect: "read"`：模型直接调用，不弹确认。
- 不是 `local`：结果算外部内容，调用之后这一轮里再做危险动作照样要确认（现有规则）。
- 托管事务可以用，例如"每天早上搜一下某某的新消息"。

## 3. 配置、设置页和提示词

### 3.1 config.json

```json
"search": { "enabled": true, "provider": "deepseek", "apiKey": "..." }
```

`provider` 是 `"deepseek"` 或 `"baidu"`，`apiKey` 可选。

### 3.2 什么时候开启

- 没有 `search` 这一节，且模型接口的主机是 `api.deepseek.com`：开启，用 DeepSeek 和模型的 key。
- `enabled: false`：关闭。设置里取消勾选会写入这一项，之后不会再默认打开。
- 选 DeepSeek、没填 key：模型是 DeepSeek 就用模型的 key；否则不开启，设置页提示"需要填 DeepSeek 的 key"。
- 选百度：必须填 AppBuilder 的 key，没有就不开启。
- 环境变量 `MOQI_SEARCH_API_KEY` 覆盖 key，和 `MOQI_API_KEY` 一样。

### 3.3 设置页

新增"联网搜索"一节：

- 勾选"开启联网搜索"。
- 下拉选服务：DeepSeek / 百度 AI 搜索。
- token 输入框：DeepSeek 提示"留空就用模型的 key"，百度提示"填 AppBuilder API Key"。
- "试一下"按钮：真的搜一次"今天的新闻"，显示第一条结果的标题，或出错原因。
- key 和模型的 key 一样：存在 config.json 里，不会发回页面，页面只显示"已保存"；留空保存沿用原来的 key。
- 保存后重建 moqi，立即生效。

### 3.4 提示词

开启时，系统提示词"做事的方式"里多一条：

> 查资料、看新闻、找网页内容，先用 web_search 搜，再用 web_read 读需要的网页；只有要登录、点按钮、填表时才用浏览器。

没开启时既没有这一条，也没有这两个工具。

## 4. 安全和边界

- 两个工具只读、不弹确认；结果是外部内容，之后的危险动作照样要确认。
- moqi 自己下载网页时（只在百度的 `web_read`）：
  - 只接受 `http` 和 `https`，拒绝带用户名或密码的网址。
  - 拒绝本机和局域网地址：`localhost`、`*.local`，以及写成 IP 的回环、私网和链路本地地址（`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`、`::1`、`fc00::/7`、`fe80::/10`），防止网页里的指令让 moqi 去读本机控制台、路由器或 NAS。
  - 不让 `fetch` 自动跳转：每跳一次重新检查地址，最多 5 次。
  - 只读 `text/html` 和纯文本，正文最多 2 MB，超时 20 秒。
  - 防不住：公网域名在解析时指向内网 IP（DNS 重绑定）。内核不碰 Node API，看不到解析结果。moqi 控制台的每个接口都要钥匙，所以这样也读不到控制台。写进文档。
- DeepSeek 的 Fetch 在 DeepSeek 的服务器上执行，碰不到用户的局域网。
- 数据去向：用 DeepSeek 时，搜索词和网址发给 DeepSeek，也就是对话已经在用的那家；用百度时，搜索词发给百度，是新的去处，所以要用户自己选；百度路径下读网页，是用户的电脑直接访问那个网站。
- 费用：DeepSeek 搜索和读网页各是每 1000 次 0.75 美元，失败和空结果不收费；百度每天免费 100 次，超出按量计费。托管事务里的搜索也计入。
- 浏览器保留，用来处理需要登录、点按钮的事。

## 5. 测试

全部用假的 `fetch`：

- DeepSeek：搜索和读网页的网址、请求体、`Bearer` 头；结果解析和截断；401、402、429、404 的中文原因。
- 百度：请求体、两个认证头、`references` 解析、额度用完的提示。
- moqi 自己下载网页：提取正文；拒绝本机和局域网地址（含 IP 写法）；重定向到 `127.0.0.1` 被拦住；拒绝带用户名密码的网址；非网页内容和超过 2 MB 的处理。
- 开启规则：模型是 DeepSeek 且没有 `search` 时开启；`enabled: false` 不开；非 DeepSeek 且没 key 不开；百度没 key 不开；`MOQI_SEARCH_API_KEY` 覆盖。
- 对话：开启时模型能看到两个工具、提示词里有那一条；调用不触发确认；之后的危险动作仍要确认；关闭时工具和提示词都不出现。
- 设置页：key 不会发回页面；留空保存沿用原来的 key；"试一下"显示第一条结果或出错原因。

## 6. 文档

- README（中英文）：能力一节加联网搜索；配置一节加 `search`；"什么会离开你的电脑"写明搜索词发往 DeepSeek 或百度；写明内网地址的保护和 DNS 重绑定的限制。
- `docs/design.md`：为什么用搜索接口而不是浏览器，为什么默认跟着 DeepSeek 开启。
- CHANGELOG：升级后，模型是 DeepSeek 就会自动打开联网搜索，不想要可以在设置里关掉。

## 7. 发布

- 分支 `feat/web-search`，发 moqi 0.9.0。taugraph 和两个兄弟包不用改。

## 8. 不做

- DeepSeek 的服务端联网工具（`deepseek_web_search`）：官方说明它是给聊天机器人用的，agent 应该用 Search 和 Fetch 接口。
- 国外搜索服务和 SearXNG：以后按需加适配器；现在需要的话可以通过 MCP 接入。
- 图片搜索、按站点或时间过滤：以后需要再加参数。
