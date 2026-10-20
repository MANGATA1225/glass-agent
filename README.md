# glass-agent

一个可以直接运行的轻量 Agent 框架。核心只有模型接口、工具注册和有上限的工具调用循环。Python 3.9+；直连 Chat Completions 无第三方依赖，Qoder 后端只增加一个加密库。

## 快速开始

```sh
cd /path/to/glass-agent
export OPENAI_API_KEY='你的模型 API Key'
python3 -m glass_agent --workspace . "这个项目有哪些文件？"
```

不传问题会进入交互模式，输入 `exit` 退出。默认模型是 `gpt-4.1-mini`，也可以用 `--model` 或 `GLASS_MODEL` 指定。`--base-url` / `GLASS_BASE_URL` 可指向兼容 Chat Completions 的服务，URL 应指向 API 根路径，例如 `https://api.openai.com/v1`。HTTP 只允许本机地址，避免把 API Key 发到明文远程连接。模型 API Key 与这个仓库的 GitHub token 无关。

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
| `glass_agent/tools.py` | 工作区只读文件工具 |
| `glass_agent/__main__.py` | 命令行入口 |

每步由模型返回文字或工具调用。Agent 验证工具名和参数，执行工具，将结果按 `tool_call_id` 送回模型，直到收到最终文字或达到 `--max-steps`。一次请求成功后才写入内存会话历史；重启后不保留会话。工具按顺序执行，不支持并行或流式输出。

默认工具仅能列出和读取工作区内的可见文件，禁止隐藏文件、`.git`、越界路径及指向这些位置的符号链接。读取限 64 KiB，工具返回给模型的内容默认限 8000 字符。框架不是进程沙箱；新增可写工具前应自行加权限控制。

## 扩展工具

```python
from glass_agent import Agent, ChatCompletionsModel, Tool

echo = Tool(
    name="echo",
    description="Return the given text",
    parameters={
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
        "additionalProperties": False,
    },
    execute=lambda args: args["text"],
)

agent = Agent(ChatCompletionsModel(api_key="..."), [echo])
print(agent.run("Call echo with hello"))
```

内置参数检查支持顶层对象的 `required`、`additionalProperties: false` 和 `string`、`integer`、`number`、`boolean` 类型。更复杂的参数应在工具函数内部验证。

设计取舍参考了当前工作区的 Pi、Kepler Agent 和 Claude Code 快照中的模型／工具循环；这里独立实现，没有复制它们的代码或引入它们的依赖。
