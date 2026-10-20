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

上下文接近 `--context-budget`（默认 60000 字符）的 75% 时，旧的完整轮次由当前模型摘要，最近轮次保持原文。压缩不会拆开工具调用和结果；开启持久化后，原始对话仍保存在会话文件中。字符数是预算近似值，不是精确 token 数；摘要会增加一次模型请求。

## 只读权限

Agent 只能注册并调用内置的 `list_files` 和 `read_file`。写工具、Bash 与命令执行工具均被拒绝；模型自行请求未知工具也不会执行。工具只能访问工作区内可见的 UTF-8 文件，隐藏文件、`.git`、越界路径和越界符号链接不可读。单个文件上限 64 KiB，工具结果默认最多 8000 字符。`--save`、`--continue` 和 `--session` 是由程序本身写会话文件的显式选项。这里限制的是 Agent 工具权限，不是操作系统级沙箱。

## 开发

```sh
npm run check
npm test
```

| 文件 | 作用 |
| --- | --- |
| `src/agent.ts` | 模型与工具循环、上下文压缩、只读工具校验 |
| `src/tools.ts` | 工作区只读文件工具 |
| `src/models.ts` | Chat Completions 适配器 |
| `src/qoder.ts` | Qoder PAT 交换、模型发现、COSY 签名与流解析 |
| `src/session.ts` | 原子写入、恢复会话 |
| `src/cli.ts` | 命令行入口 |

测试使用模拟模型和模拟 Qoder 响应，不使用真实 PAT。
