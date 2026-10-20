import base64
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from glass_agent.core import Agent
from glass_agent.provider import ModelError
from glass_agent.qoder import ENCODING_ALPHABET, QoderModel, STANDARD_ALPHABET
from glass_agent.tools import workspace_tools


def qoder_event(body):
    return ("data: " + json.dumps({"statusCodeValue": 200, "body": body}) + "\n\n").encode()


def decode_body(data):
    encoded = data.decode("ascii")
    third = len(encoded) // 3
    original = encoded[-third:] + encoded[third:-third] + encoded[:third]
    original = original.translate(str.maketrans(ENCODING_ALPHABET + "$", STANDARD_ALPHABET + "="))
    return json.loads(base64.b64decode(original))


class FakeQoderOpener:
    def __init__(self):
        self.calls = []
        self.chat_bodies = []

    def open(self, request, timeout):
        path = urlsplit(request.full_url).path
        self.calls.append(path)
        if path == "/api/v1/jobToken/exchange":
            self._check(request, signed=False)
            assert json.loads(request.data) == {"personal_token": "synthetic-pat"}
            expiry = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            return io.BytesIO(json.dumps({"token": "synthetic-job", "expires_at": expiry}).encode())
        if path == "/api/v1/userinfo":
            assert request.get_header("Authorization") == "Bearer synthetic-job"
            return io.BytesIO(b'{"id":"synthetic-user","organization_id":"synthetic-org"}')
        self._check(request, signed=True)
        if path == "/algo/api/v2/model/list":
            return io.BytesIO(b'{"assistant":[{"key":"live-key","display_name":"Live Model","enable":true,"source":"system"}]}')
        assert path == "/algo/api/v2/service/pro/sse/agent_chat_generation"
        body = decode_body(request.data)
        self.chat_bodies.append(body)
        assert request.get_header("X-model-key") == "live-key"
        if len(self.chat_bodies) == 1:
            chunk = {"choices": [{"delta": {"tool_calls": [{
                "index": 0, "id": "call-1",
                "function": {"name": "read_file", "arguments": '{"path":"notes.txt"}'},
            }]}, "finish_reason": "tool_calls"}]}
        else:
            assert body["messages"][-2]["content"] == " "
            assert body["messages"][-1]["tool_call_id"] == "call-1"
            assert body["messages"][-1]["content"] == "hello"
            chunk = {"choices": [{"delta": {"content": "done"}, "finish_reason": "stop"}]}
        return io.BytesIO(qoder_event(json.dumps(chunk)) + qoder_event("[DONE]"))

    @staticmethod
    def _check(request, signed):
        headers = str(request.headers)
        assert "synthetic-pat" not in headers
        if not signed:
            return
        authorization = request.get_header("Authorization")
        assert authorization.startswith("Bearer COSY.")
        payload, signature = authorization.removeprefix("Bearer COSY.").split(".")
        body = request.data or b""
        path = urlsplit(request.full_url).path.removeprefix("/algo")
        signed_bytes = (payload.encode() + b"\n" + request.get_header("Cosy-key").encode()
                        + b"\n" + request.get_header("Cosy-date").encode()
                        + b"\n" + body + b"\n" + path.encode())
        assert hashlib.md5(signed_bytes).hexdigest() == signature
        assert "synthetic-job" not in base64.b64decode(payload).decode()


class QoderTests(unittest.TestCase):
    @unittest.skipUnless(importlib.util.find_spec("cryptography"), "optional Qoder dependency is not installed")
    def test_native_auth_catalog_and_tool_round_trip(self):
        transport = FakeQoderOpener()
        model = QoderModel("synthetic-pat", "Live Model")
        model._opener = transport
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "notes.txt").write_text("hello", encoding="utf-8")
            self.assertEqual(Agent(model, workspace_tools(workspace)).run("read notes"), "done")
        self.assertEqual(len(transport.chat_bodies), 2)
        self.assertEqual(transport.chat_bodies[0]["model_config"]["key"], "live-key")
        self.assertEqual(transport.chat_bodies[0]["session_id"], transport.chat_bodies[1]["session_id"])
        self.assertNotEqual(transport.chat_bodies[0]["request_id"], transport.chat_bodies[1]["request_id"])
        self.assertEqual(transport.calls.count("/api/v1/jobToken/exchange"), 1)
        self.assertEqual(transport.calls.count("/algo/api/v2/model/list"), 1)

    def test_incomplete_stream_is_rejected(self):
        partial = qoder_event(json.dumps({"choices": [{"delta": {"content": "partial"}}]}))
        with self.assertRaises(ModelError):
            QoderModel._read_stream(io.BytesIO(partial))

    def test_unofficial_endpoint_is_rejected(self):
        with self.assertRaises(ValueError):
            QoderModel("synthetic-pat", "model", base_url="https://example.com")


if __name__ == "__main__":
    unittest.main()
