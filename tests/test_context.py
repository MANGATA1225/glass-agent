import json
import tempfile
import unittest
from pathlib import Path

from glass_agent.core import Agent, AgentError, Completion, ContextLimitExceeded
from glass_agent.session import SessionStore


class RecordingModel:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def complete(self, messages, tools):
        self.requests.append((messages, tools))
        return next(self.responses)


class ContextTests(unittest.TestCase):
    def test_compaction_keeps_recent_complete_turn(self):
        model = RecordingModel([
            Completion({"content": "Older work summarized"}, "stop"),
            Completion({"content": "third answer"}, "stop"),
        ])
        agent = Agent(model, [], context_budget=1000)
        agent.history = [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "A" * 300},
            {"role": "user", "content": "second"},
            {"role": "assistant", "content": "B" * 300},
        ]
        self.assertEqual(agent.run("third"), "third answer")
        self.assertEqual(model.requests[0][1], [])
        self.assertIn("first", model.requests[0][0][1]["content"])
        self.assertEqual(model.requests[1][0][1]["role"], "system")
        self.assertEqual(model.requests[1][0][2]["content"], "second")
        self.assertEqual(agent.first_kept_index, 2)
        self.assertEqual(len(agent.history), 6)

    def test_failed_compaction_does_not_discard_history(self):
        model = RecordingModel([Completion({"content": ""}, "stop")])
        agent = Agent(model, [], context_budget=1000)
        agent.history = [{"role": "user", "content": "old"},
                         {"role": "assistant", "content": "x" * 800}]
        with self.assertRaises(AgentError):
            agent.run("new")
        self.assertEqual(agent.first_kept_index, 0)
        self.assertEqual(len(agent.history), 2)

    def test_tool_call_and_result_stay_together(self):
        model = RecordingModel([
            Completion({"content": "summary"}, "stop"),
            Completion({"content": "answer"}, "stop"),
        ])
        agent = Agent(model, [], context_budget=1200)
        agent.history = [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "A" * 700},
            {"role": "user", "content": "second"},
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "file result"},
            {"role": "assistant", "content": "found it"},
        ]
        agent.run("third")
        live = model.requests[1][0]
        self.assertEqual(live[2]["content"], "second")
        self.assertEqual(live[3]["tool_calls"][0]["id"], "c1")
        self.assertEqual(live[4]["tool_call_id"], "c1")

    def test_oversized_active_turn_has_clear_error(self):
        agent = Agent(RecordingModel([]), [], context_budget=1000)
        with self.assertRaises(ContextLimitExceeded):
            agent.run("x" * 1200)

    def test_repeated_compaction_includes_previous_summary(self):
        model = RecordingModel([
            Completion({"content": "updated summary"}, "stop"),
            Completion({"content": "done"}, "stop"),
        ])
        agent = Agent(model, [], context_budget=1000)
        agent.summary = "original decision"
        agent.history = [{"role": "user", "content": "old"},
                         {"role": "assistant", "content": "x" * 300},
                         {"role": "user", "content": "middle"},
                         {"role": "assistant", "content": "y" * 300}]
        agent.first_kept_index = 2
        agent._compact(agent.history + [{"role": "user", "content": "next"}], [])
        self.assertEqual(agent.run("next"), "done")
        self.assertIn("original decision", model.requests[0][0][1]["content"])
        self.assertEqual(agent.summary, "updated summary")

    def test_session_round_trip_and_identity_check(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            path = SessionStore.new_path(workspace)
            store = SessionStore(path, workspace, "qoder", "example-model")
            agent = Agent(RecordingModel([]), [])
            agent.history = [{"role": "user", "content": "hello"},
                             {"role": "assistant", "content": "world"}]
            agent.summary = "earlier summary"
            agent.first_kept_index = 2
            store.save(agent)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(SessionStore.latest_path(workspace), path)
            restored = Agent(RecordingModel([]), [])
            store.load(restored)
            self.assertEqual(restored.history, agent.history)
            self.assertEqual(restored.summary, agent.summary)
            self.assertEqual(restored.first_kept_index, 2)
            with self.assertRaises(ValueError):
                SessionStore(path, workspace, "openai", "example-model").load(restored)
            self.assertNotIn("personal_token", json.loads(path.read_text()))

    def test_remote_session_id_restored_without_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            store = SessionStore(SessionStore.new_path(workspace), workspace, "qoder", "example")
            first = RecordingModel([])
            first.session_id = "original-id"
            store.save(Agent(first, []))
            second = RecordingModel([])
            second.session_id = "new-id"
            store.load(Agent(second, []))
            self.assertEqual(second.session_id, "original-id")


if __name__ == "__main__":
    unittest.main()
