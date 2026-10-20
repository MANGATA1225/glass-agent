import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from glass_agent.core import Agent, AgentError, Completion, StepLimitExceeded, Tool
from glass_agent.provider import ChatCompletionsModel
from glass_agent.tools import workspace_tools


class SequenceModel:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def complete(self, messages, tools):
        self.requests.append((messages, tools))
        return next(self.responses)


def tool_call(arguments='{"text":"hello"}'):
    return {
        "id": "call_1",
        "type": "function",
        "function": {"name": "echo", "arguments": arguments},
    }


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.tool = Tool(
            "echo", "Echo text",
            {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False},
            lambda args: args["text"],
        )

    def test_tool_round_trip_and_history(self):
        model = SequenceModel([
            Completion({"content": None, "tool_calls": [tool_call()]}, "tool_calls"),
            Completion({"content": "hello"}, "stop"),
        ])
        agent = Agent(model, [self.tool])
        self.assertEqual(agent.run("Say hello"), "hello")
        second_request = model.requests[1][0]
        self.assertEqual(second_request[-2]["tool_calls"][0]["id"], "call_1")
        self.assertEqual(second_request[-1], {"role": "tool", "tool_call_id": "call_1", "content": "hello"})
        self.assertEqual(agent.history[-1]["content"], "hello")

    def test_bad_arguments_return_tool_error(self):
        model = SequenceModel([
            Completion({"content": None, "tool_calls": [tool_call('{"text":42}')]}, "tool_calls"),
            Completion({"content": "Recovered"}, "stop"),
        ])
        agent = Agent(model, [self.tool])
        self.assertEqual(agent.run("test"), "Recovered")
        self.assertIn("invalid type", model.requests[1][0][-1]["content"])

    def test_step_limit_does_not_execute_tool(self):
        called = []
        tool = Tool(self.tool.name, self.tool.description, self.tool.parameters, lambda args: called.append(args))
        model = SequenceModel([Completion({"content": None, "tool_calls": [tool_call()]}, "tool_calls")])
        agent = Agent(model, [tool], max_steps=1)
        with self.assertRaises(StepLimitExceeded):
            agent.run("test")
        self.assertEqual(called, [])
        self.assertEqual(agent.history, [])

    def test_truncated_call_is_not_executed(self):
        called = []
        tool = Tool(self.tool.name, self.tool.description, self.tool.parameters, lambda args: called.append(args))
        model = SequenceModel([Completion({"content": None, "tool_calls": [tool_call()]}, "length")])
        with self.assertRaises(AgentError):
            Agent(model, [tool]).run("test")
        self.assertEqual(called, [])


class WorkspaceTests(unittest.TestCase):
    def test_read_only_visible_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "notes.txt").write_text("hello", encoding="utf-8")
            (root / ".git").mkdir()
            (root / ".git" / "config").write_text("secret", encoding="utf-8")
            (root / "outside-link").symlink_to(root / ".git" / "config")
            tools = {tool.name: tool for tool in workspace_tools(root)}
            self.assertEqual(tools["read_file"].execute({"path": "notes.txt"}), "hello")
            self.assertEqual(tools["list_files"].execute({}), "notes.txt")
            for path in (".git/config", "../notes.txt", "outside-link"):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    tools["read_file"].execute({"path": path})


class ProviderTests(unittest.TestCase):
    def test_chat_completions_wire_format(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, *_args):
                return b'{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}'

        captured = []

        def fake_urlopen(request, timeout):
            captured.append((request, timeout))
            return FakeResponse()

        model = ChatCompletionsModel("fake-key", base_url="https://example.test/v1")
        with patch("urllib.request.urlopen", fake_urlopen):
            response = model.complete([{"role": "user", "content": "hi"}], [{"type": "function", "function": {"name": "echo"}}])
        self.assertEqual(response.message["content"], "done")
        self.assertEqual(captured[0][0].full_url, "https://example.test/v1/chat/completions")
        payload = json.loads(captured[0][0].data)
        self.assertEqual(payload["tools"][0]["function"]["name"], "echo")
        self.assertEqual(payload["messages"][0]["role"], "user")
        self.assertEqual(captured[0][0].get_header("Authorization"), "Bearer fake-key")


if __name__ == "__main__":
    unittest.main()
