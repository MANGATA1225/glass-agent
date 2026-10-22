# glass-agent

使用 TypeScript 和 Node.js 24+ 实现的轻量只读 Agent。模型循环、上下文压缩、会话恢复、工作区文件工具和 ChatGPT、Qoder 适配均在 `src/` 中。运行时使用 `jose` 校验 ChatGPT 的 OIDC ID token；TypeScript 仅用于类型检查。

## 安装与运行

```sh
cd /Users/zhuanz/glass-agent
npm ci
npm start -- --provider chatgpt --login
npm start -- --provider chatgpt --list-models
npm start -- --provider chatgpt --model '上一步返回的模型 slug' --workspace .
```

默认 provider 是 `chatgpt`，需要先登录，再选择账号模型目录返回的 slug。一次性提问可在末尾加问题。不传问题时进入交互模式，输入 `exit` 退出。
`--workspace` 指定 Agent 能查看的目录；省略时使用启动命令所在目录。程序只把工作区名称告诉模型；模型需要调用 `list_files` 和 `read_file` 才能查看文件名和代码内容。终端与 Slack 回复会把工作区绝对路径转换为以工作区名称开头的路径，用户主目录下的其他路径以 `~` 开头显示，其他常见本机绝对路径显示为 `[local path]`；流式输出也会在发出文字前处理路径。

## ChatGPT 套餐授权

`--login` 会在运行 glass-agent 的电脑上监听 `127.0.0.1:1455/auth/callback`（端口占用时使用其他本地端口），输出官方授权链接，并等待五分钟。浏览器和程序在同一台电脑时可自动收到回调。若浏览器在另一台电脑，在该浏览器完成授权后，把地址栏中的**完整回调 URL 粘贴到运行 glass-agent 的终端**；输入不会回显。浏览器显示无法连接本地回调地址时，仍可复制地址栏 URL。一次登录尝试的回调只能使用一次；过期后重新执行 `--login`。不要把回调 URL 发到聊天、工单或日志中。

首次授权用 `dynamic_agent_client` 注册，后续使用回调返回的正式 client ID。程序校验 state、PKCE、ID token 签名与 nonce、账号身份及授权 scope 后才保存凭据。Host ID 和凭据默认位于 `~/.config/glass-agent/chatgpt/`，目录权限 `0700`、文件权限 `0600`，不在工作区会话中。续期使用单份本地凭据和跨进程锁，替换 refresh token 后原子写入。ChatGPT 凭据只发送到官方认证端点及 `https://api.openai.com/v1/models`、`/responses`；`--base-url` 对此 provider 禁用。套餐资格、模型和额度由 OpenAI 账号实际授权决定。

可参考 OpenAI 官方文档：[登录授权](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[当前限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。

## Slack Bot（Socket Mode）

glass-agent 可以在本机连接 Slack，接收允许用户发来的 DM，以及频道里的显式 @提及，然后用现有 ChatGPT 模型和只读工作区工具回答。使用 [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)，无需公网域名、ngrok、Request URL 或 Signing Secret。参考包中的 Kepler HTTP gateway 配置不适用于这个本地入口。

1. 在 [Slack App 管理页](https://api.slack.com/apps)创建 App，可导入 [Manifest](examples/slack-app-manifest.yaml)。确认启用了 Socket Mode，Bot scopes 至少有 `app_mentions:read`、`im:history`、`chat:write`，Bot events 为 `app_mention`、`message.im`。修改 scopes 或事件后安装／重新安装到你的 Slack workspace。频道中使用时还需邀请 Bot 加入频道。
2. 在 **Basic Information → App-Level Tokens** 生成带 `connections:write` scope 的 `xapp-...` token；在 **OAuth & Permissions → Bot User OAuth Token** 复制 `xoxb-...` token。取得你自己的 Slack **member ID**（`U...` 或 `W...`），不是 App ID、Bot ID 或 workspace ID。
3. 创建只在本机保存的配置文件，然后编辑它：

   ```sh
   cd /Users/zhuanz/glass-agent
   npm start -- --slack-init
   nano ~/.config/glass-agent/slack.env
   ```

   把 `SLACK_APP_TOKEN`、`SLACK_BOT_TOKEN`、`SLACK_ALLOWED_USERS` 的占位值替换成自己的值；多个用户 ID 用逗号分隔。`SLACK_ALLOWED_CHANNELS` 可选，填 `C...`／`G...` 频道 ID 可限制频道提及；留空时允许已加入频道中的允许用户提及。这个文件默认权限是 `0600`，位于 Agent 可读工作区之外，不要提交到 Git 或在聊天中发送 token。
4. 使用已授权的 ChatGPT 模型启动 Bot：

   ```sh
   npm start -- --provider chatgpt --model '模型 slug' --workspace . --slack
   ```

Bot 会自动调用 `auth.test` 确认自己的用户 ID。DM 在同一运行进程里共享上下文；频道中的每个根消息线程各有独立上下文。当前 Slack 会话只保存在内存中，进程重启后重新开始；此入口只处理文字消息，不下载 Slack 附件。Agent 仍只能调用 `list_files` 和 `read_file`，发送回答由 Slack 适配器完成。

## API Key provider

原有 OpenAI Chat Completions API Key 模式仍可单独使用：

```sh
export OPENAI_API_KEY='你的模型 API Key'
npm start -- --provider openai --model gpt-4.1-mini --workspace .
```

此模式可通过 `--base-url` 或 `GLASS_BASE_URL` 调整接口地址；远程地址必须为 HTTPS，本机地址可用 HTTP。ChatGPT 套餐模式不会自动切换到 API Key 计费。

交互模式默认逐段显示模型文本；一次性命令默认等完整回答返回。用 `--stream` 可为一次性命令开启流式输出，`--no-stream` 可关闭交互模式流式输出。ChatGPT 套餐模式始终向服务端请求流式 Responses；解析器会收集流中的文本和已完成的输出项，收到 `response.completed` 后才采纳回答和执行工具。若已经显示部分文本后连接中断，会显示错误，不自动重试这段可见输出。

## Qoder

Qoder Personal Access Token（PAT）不是 OpenAI API Key。先用 PAT 换取短期 job token，读取账号启用的模型列表，再按 Qoder 原生 COSY 协议调用模型。工具调用和会话历史仍由 glass-agent 控制。

```sh
export QODER_PERSONAL_ACCESS_TOKEN='你的 Qoder PAT'
npm start -- --provider qoder --list-models
npm start -- --provider qoder --model '上一步返回的模型 key' --workspace .
```

模型也可用列表中的完整显示名称指定。默认端点是 `https://api2.qoder.sh`；`--base-url` 或 `QODER_BASE_URL` 仅允许选择官方 `api2`、`api3` 端点。PAT 和短期凭据只保存在进程内存里。Qoder 原生模型协议参考了本地 Kepler Agent 的实现，服务端协议变化可能需要更新适配器。

## 会话与上下文

默认会话只保存在内存中，运行 Agent 不写本地文件。明确需要持久化时传 `--save`；会话以权限 `0600` 写到工作区 `.glass-agent/sessions/<id>.json`。`--continue` 恢复该工作区最近的会话，`--session 路径` 指定会话文件；这两个选项也会继续保存。恢复时工作区、provider 和模型必须一致。会话格式与先前 Python 版本的 JSON 文件兼容，包含原始问答和工具结果，但不包含 API Key/PAT。

```sh
npm start -- --provider qoder --model '模型 key' --workspace . --save
npm start -- --provider qoder --model '模型 key' --workspace . --continue
```

上下文预算默认 120000 字符。`read_file` 每次最多返回 6000 字符，并给出续读的 `offset`；同一批多个工具调用共享最多约 24000 字符的输出预算。接近预算时，发给模型的上下文会先清理较旧的工具结果，保留最近两个；仍然偏大时，才按完整问答或工具调用边界分块生成摘要。运行中的会话历史保留原始工具结果，开启持久化后也会写入会话文件。预算按字符估算，不是模型的精确 token 上限；生成摘要会增加模型请求。

## 失败重试

模型请求遇到网络超时、连接错误、HTTP 408/409/429/5xx、Qoder 或 ChatGPT 流意外中断、空回答时，默认最多额外重试 2 次。优先遵循服务端 `Retry-After-Ms` 或 `Retry-After`，否则以约 0.5 秒、1 秒的指数退避等待并加入少量随机抖动；服务端要求等待超过 60 秒时会直接报错。终端会显示重试次数、等待时间和错误原因。可用 `--max-retries 0` 关闭，或用其他非负整数调整次数。401/403、无效模型或协议数据等明确错误会立即返回。回答和摘要都适用此策略；工具仅在模型请求成功后执行。

## 只读权限

Agent 只能注册并调用内置的 `list_files` 和 `read_file`。写工具、Bash 与命令执行工具均被拒绝；模型自行请求未知工具也不会执行。工具只能访问工作区内可见的 UTF-8 文件，隐藏文件、`.git`、越界路径和越界符号链接不可读。单个文件上限 1 MiB；`read_file` 使用从 0 开始的字符 `offset` 续读。`--save`、`--continue` 和 `--session` 是由程序本身写会话文件的显式选项。这里限制的是 Agent 工具权限，不是操作系统级沙箱。

## 开发

```sh
npm run check
npm test
```

| 文件 | 作用 |
| --- | --- |
| `src/agent.ts` | 模型与工具循环、上下文压缩、只读工具校验 |
| `src/retry.ts` | 有界重试与退避策略 |
| `src/tools.ts` | 工作区只读文件工具 |
| `src/models.ts` | Chat Completions 适配器 |
| `src/output.ts` | 终端流式输出与 Slack 回复的本地路径处理 |
| `src/chatgpt-auth.ts` | ChatGPT OAuth、OIDC 校验、私有凭据和自动续期 |
| `src/chatgpt-model.ts` | ChatGPT 模型目录与 Responses 流、工具调用适配 |
| `src/slack.ts` | Slack Socket Mode、用户白名单、会话路由与消息投递 |
| `src/qoder.ts` | Qoder PAT 交换、模型发现、COSY 签名与流解析 |
| `src/session.ts` | 原子写入、恢复会话 |
| `src/cli.ts` | 命令行入口 |

测试使用模拟模型、ChatGPT 授权与响应、Qoder 响应，不使用真实凭据。
