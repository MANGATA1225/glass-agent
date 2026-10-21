# glass-agent

使用 TypeScript 和 Node.js 24+ 实现的轻量只读 Agent。模型循环、上下文压缩、会话恢复、工作区文件工具和 Qoder 适配均在 `src/` 中；运行时只使用 Node 内置 API，TypeScript 仅用于类型检查。

## 安装与运行

```sh
cd /Users/zhuanz/glass-agent
npm ci
export OPENAI_API_KEY='你的模型 API Key'
npm start -- --workspace . '这个项目有哪些文件？'
```

默认使用 `gpt-4.1-mini` 和 OpenAI Chat Completions。可通过 `--model`、`--base-url` 或 `GLASS_MODEL`、`GLASS_BASE_URL` 调整；远程地址必须为 HTTPS，本机地址可用 HTTP。不传问题时进入交互模式，输入 `exit` 退出。

交互模式默认逐段显示模型文本；一次性命令默认等完整回答返回。用 `--stream` 可为一次性命令开启流式输出，`--no-stream` 可关闭交互模式流式输出。Qoder 原生 SSE 与 OpenAI 兼容接口均支持；工具参数会等到流完整结束并校验后再执行。若已经显示部分文本后连接中断，会显示错误，不自动重试这段可见输出。

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

模型请求遇到网络超时、连接错误、HTTP 408/409/429/5xx、Qoder 流意外中断或空回答时，默认最多额外重试 2 次。优先遵循服务端 `Retry-After-Ms` 或 `Retry-After`，否则以约 0.5 秒、1 秒的指数退避等待并加入少量随机抖动；服务端要求等待超过 60 秒时会直接报错。终端会显示重试次数、等待时间和错误原因。可用 `--max-retries 0` 关闭，或用其他非负整数调整次数。401/403、无效模型或协议数据等明确错误会立即返回。回答和摘要都适用此策略；工具仅在模型请求成功后执行。

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
| `src/qoder.ts` | Qoder PAT 交换、模型发现、COSY 签名与流解析 |
| `src/session.ts` | 原子写入、恢复会话 |
| `src/cli.ts` | 命令行入口 |

测试使用模拟模型和模拟 Qoder 响应，不使用真实 PAT。
