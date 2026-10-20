# glass-agent

一个可以直接运行的轻量 Agent 框架。核心只有模型接口、工具注册和有上限的工具调用循环。Python 3.9+；直连 Chat Completions 无第三方依赖，Qoder 后端只增加一个加密库。

## 快速开始

```sh
cd /path/to/glass-agent
export OPENAI_API_KEY='你的模型 API Key'
python3 -m glass_agent --workspace . "这个项目有哪些文件？"
```

不传问题会进入交互模式，输入 `exit` 退出。默认模型是 `gpt-4.1-mini`，也可以用 `--model` 或 `GLASS_MODEL` 指定。`--base-url` / `GLASS_BASE_URL` 可指向兼容 Chat Completions 的服务，URL 应指向 API 根路径，例如 `https://api.openai.com/v1`。HTTP 只允许本机地址，避免把 API Key 发到明文远程连接。模型 API Key 与这个仓库的 GitHub token 无关。

## 会话和上下文

默认仅在内存中保留对话，退出后不写入本地文件。显式传 `--save` 后，第一次成功回答会把完整对话保存在工作区的 `.glass-agent/sessions/<id>.json`（权限 `0600`，目录已加入 `.gitignore`）。启动时会在终端输出会话路径；下次用 `--continue` 恢复该工作区最近一次会话，或用 `--session 路径` 恢复指定会话，这两个选项也会继续保存对话。恢复时工作区、provider 和模型需与原会话一致。`--no-save` 可以显式指定仅在内存中保留。会话包含原始提问、回答和工具结果，请妥善保管；API Key/PAT 不写入会话。Qoder 的会话标识会随会话一起恢复。

```sh
python3 -m glass_agent --provider qoder --model '模型 key' --workspace . --save
python3 -m glass_agent --provider qoder --model '模型 key' --workspace . --continue
```

上下文接近 `--context-budget` 指定的字符预算（默认 60000 字符的约 75%）时，会用当前模型把较早的**完整轮次**压成摘要，保留最近轮次原文；摘要也会存入会话文件，完整原始对话不会删除。工具调用和结果始终作为同一轮处理。下一次压缩会携带上次摘要。这个预算是字符估算而非模型精确 token 数，实际上下文上限仍取决于模型；可按模型容量调整 `--context-budget`。

## 使用 Qoder 账号模型

Qoder 的 Personal Access Token（PAT）不是 OpenAI API Key，也不能发到 `/chat/completions`。Qoder 后端先用 PAT 换取短期 job token，再读取当前账号实际启用的模型列表，最后按 Qoder 原生协议请求所选模型。工具执行和会话历史仍由 glass-agent 控制。

```sh
cd /path/to/glass-agent
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements-qoder.txt
export QODER_PERSONAL_ACCESS_TOKEN='你的 Qoder PAT'
python3 -m glass_agent --provider qoder --list-models
python3 -m glass_agent --provider qoder --model '上一步返回的模型 key' --workspace . '这个项目有哪些文件？'
```

`--model` 也接受列表中的完整显示名称。交互模式同样适用。默认使用 `https://api2.qoder.sh`；可设置 `QODER_BASE_URL=https://api3.qoder.sh` 或传 `--base-url` 选择另一官方全球端点。PAT 和短期凭据只保留在进程内存中，不写入项目文件或 Git 配置。不要把 Qoder PAT 当作 `OPENAI_API_KEY`。

此原生协议适配参考了本机 Kepler Agent 的实现；Qoder 官方文档支持通过 Agent SDK 使用 PAT，但没有承诺这个独立模型协议长期稳定。若 Qoder 调整协议，适配器可能需要更新。

```sh
python3 -m glass_agent --help
python3 -m unittest discover -s tests -v
```

## 结构

| 文件 | 作用 |
| --- | --- |
| `glass_agent/core.py` | Agent 循环、模型接口、工具契约、参数检查和步数上限 |
| `glass_agent/provider.py` | Chat Completions HTTP 适配器 |
| `glass_agent/qoder.py` | Qoder PAT 交换、账号模型发现、原生模型请求 |
| `glass_agent/session.py` | 会话快照持久化和恢复 |
| `glass_agent/tools.py` | 工作区只读文件工具 |
| `glass_agent/__main__.py` | 命令行入口 |

每步由模型返回文字或工具调用。Agent 验证工具名和参数，执行工具，将结果按 `tool_call_id` 送回模型，直到收到最终文字或达到 `--max-steps`。一次请求成功后写入会话历史；压缩成功后也保存摘要。工具按顺序执行，不支持并行或流式输出。

运行时只允许内置的 `list_files` 和 `read_file`。写文件、修改代码和 Bash/命令执行工具均不能注册或调用；模型自行请求未知工具也不会得到执行。只读工具仅能列出和读取工作区内的可见文件，禁止隐藏文件、`.git`、越界路径及指向这些位置的符号链接。读取限 64 KiB，工具返回给模型的内容默认限 8000 字符。`--save`、`--session` 和 `--continue` 会由程序本身写入会话文件。这里限制的是 Agent 的工具权限，不是操作系统级进程沙箱。

内置参数检查支持顶层对象的 `required`、`additionalProperties: false` 和 `string`、`integer`、`number`、`boolean` 类型。

设计取舍参考了当前工作区的 Pi、Kepler Agent 和 Claude Code 快照中的模型／工具循环；这里独立实现，没有复制它们的代码或引入它们的依赖。
