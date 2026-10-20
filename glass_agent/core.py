"""Provider-independent agent loop and tool contracts."""

import json
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Protocol


class AgentError(Exception):
    """The model returned an unusable response."""


class StepLimitExceeded(AgentError):
    """The agent needs more model calls than the configured limit."""


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: Dict[str, Any]
    execute: Callable[[Dict[str, Any]], Any]

    def declaration(self) -> Dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


@dataclass(frozen=True)
class Completion:
    message: Dict[str, Any]
    finish_reason: Optional[str] = None


class Model(Protocol):
    def complete(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> Completion:
        ...


def _validate_arguments(schema: Dict[str, Any], value: Any) -> Dict[str, Any]:
    """Check the small JSON Schema subset used by this framework's tools."""
    if not isinstance(value, dict):
        raise ValueError("arguments must be a JSON object")
    properties = schema.get("properties", {})
    for name in schema.get("required", []):
        if name not in value:
            raise ValueError("missing required argument: " + name)
    if schema.get("additionalProperties") is False:
        extra = set(value) - set(properties)
        if extra:
            raise ValueError("unknown argument: " + sorted(extra)[0])
    types = {"string": str, "integer": int, "number": (int, float), "boolean": bool}
    for name, item in value.items():
        declared = properties.get(name, {}).get("type")
        expected = types.get(declared)
        if expected and (not isinstance(item, expected) or declared in ("integer", "number") and isinstance(item, bool)):
            raise ValueError("invalid type for argument: " + name)
    return value


class Agent:
    """Keep successful conversation turns in memory; execute tools sequentially."""

    def __init__(
        self,
        model: Model,
        tools: List[Tool],
        system_prompt: str = "You are a helpful assistant. Use tools when needed.",
        max_steps: int = 8,
        max_tool_output: int = 8000,
    ) -> None:
        if max_steps < 1 or max_tool_output < 1:
            raise ValueError("max_steps and max_tool_output must be positive")
        names = [tool.name for tool in tools]
        if len(names) != len(set(names)):
            raise ValueError("tool names must be unique")
        self.model = model
        self.tools = {tool.name: tool for tool in tools}
        self.system_prompt = system_prompt
        self.max_steps = max_steps
        self.max_tool_output = max_tool_output
        self.history: List[Dict[str, Any]] = []

    def run(self, prompt: str) -> str:
        if not prompt.strip():
            raise ValueError("prompt must not be empty")
        working = self.history + [{"role": "user", "content": prompt}]
        declarations = [tool.declaration() for tool in self.tools.values()]
        for step in range(self.max_steps):
            response = self.model.complete(
                [{"role": "system", "content": self.system_prompt}] + working,
                declarations,
            )
            message = response.message
            if not isinstance(message, dict):
                raise AgentError("model response has no message")
            content = message.get("content")
            calls = message.get("tool_calls") or []
            if not isinstance(calls, list) or content is not None and not isinstance(content, str):
                raise AgentError("model response has an invalid message")
            if response.finish_reason == "length":
                raise AgentError("model response was truncated")
            if calls:
                if step == self.max_steps - 1:
                    raise StepLimitExceeded("maximum model steps reached before tool results could be read")
                normalized = []
                for call in calls:
                    if not isinstance(call, dict) or not isinstance(call.get("id"), str):
                        raise AgentError("model returned an invalid tool call")
                    function = call.get("function")
                    if not isinstance(function, dict) or not isinstance(function.get("name"), str) or not isinstance(function.get("arguments"), str):
                        raise AgentError("model returned an invalid tool function")
                    normalized.append({"id": call["id"], "type": "function", "function": function})
                working.append({"role": "assistant", "content": content, "tool_calls": normalized})
                for call in normalized:
                    result = self._execute(call["function"]["name"], call["function"]["arguments"])
                    working.append({"role": "tool", "tool_call_id": call["id"], "content": result})
                continue
            if content is None or not content.strip():
                raise AgentError("model returned neither text nor tool calls")
            working.append({"role": "assistant", "content": content})
            self.history = working
            return content
        raise StepLimitExceeded("maximum model steps reached")

    def _execute(self, name: str, raw_arguments: str) -> str:
        tool = self.tools.get(name)
        if tool is None:
            return "Tool error: unknown tool: " + name
        try:
            arguments = _validate_arguments(tool.parameters, json.loads(raw_arguments))
            value = tool.execute(arguments)
            result = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
            return result[: self.max_tool_output] + ("\n[truncated]" if len(result) > self.max_tool_output else "")
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            return "Tool error: " + str(exc)
        except Exception as exc:
            return "Tool error: " + type(exc).__name__
