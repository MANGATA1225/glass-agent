"""Optional Qoder model transport. The glass-agent loop still owns tools and history.

Qoder's native wire format is not an OpenAI API. This adapter follows the
account catalog and COSY request flow used by Kepler Agent's Qoder provider.
"""

import base64
import copy
import hashlib
import importlib.util
import json
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .core import Completion
from .provider import ModelError


OPENAPI = "https://openapi.qoder.sh"
OFFICIAL_ENDPOINTS = ("https://api2.qoder.sh", "https://api3.qoder.sh")
CHAT_PATH = "/algo/api/v2/service/pro/sse/agent_chat_generation"
CHAT_QUERY = "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
COSY_VERSION = "1.1.68"
ENCODING_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"
STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
PUBLIC_KEY = b"""-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----"""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _encode_body(payload: bytes) -> bytes:
    encoded = base64.b64encode(payload).decode("ascii").translate(
        str.maketrans(STANDARD_ALPHABET + "=", ENCODING_ALPHABET + "$")
    )
    third = len(encoded) // 3
    return (encoded[-third:] + encoded[third:-third] + encoded[:third]).encode("ascii")


def _expiry(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()


class QoderModel:
    """One native model request per complete(); PAT and catalog stay in memory."""

    def __init__(self, pat: str, model: Optional[str] = None,
                 base_url: str = OFFICIAL_ENDPOINTS[0], timeout: float = 60) -> None:
        if not pat.strip():
            raise ValueError("QODER_PERSONAL_ACCESS_TOKEN is required")
        if base_url.rstrip("/") not in OFFICIAL_ENDPOINTS:
            raise ValueError("Qoder endpoint must be an official global endpoint")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        if importlib.util.find_spec("cryptography") is None:
            raise ModelError("Qoder backend requires cryptography; install requirements-qoder.txt")
        self.pat = pat.strip()
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.machine_id = str(uuid.uuid4())
        self.session_id = str(uuid.uuid4())
        self._opener = urllib.request.build_opener(_NoRedirect())
        self._lock = threading.Lock()
        self._auth: Optional[Dict[str, Any]] = None
        self._catalog: List[Dict[str, Any]] = []
        self._catalog_until = 0.0

    def _open(self, request: urllib.request.Request):
        try:
            return self._opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            # Authentication and gateway bodies may echo credential material.
            raise ModelError("Qoder returned HTTP " + str(exc.code)) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ModelError("Qoder request failed: " + type(exc).__name__) from None

    def _request_json(self, method: str, url: str, data: Optional[bytes] = None,
                      headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        request = urllib.request.Request(
            url, data=data, headers={"Content-Type": "application/json", **(headers or {})}, method=method
        )
        with self._open(request) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise ModelError("Qoder response is too large")
        try:
            result = json.loads(raw)
        except (UnicodeError, ValueError):
            raise ModelError("Qoder returned invalid JSON") from None
        if not isinstance(result, dict):
            raise ModelError("Qoder returned an invalid object")
        return result

    def _credentials(self) -> Dict[str, Any]:
        if self._auth and self._auth["expires"] > time.time() + 60:
            return self._auth
        exchange = self._request_json(
            "POST", OPENAPI + "/api/v1/jobToken/exchange",
            _json_bytes({"personal_token": self.pat}),
        )
        token = exchange.get("token")
        try:
            expires = _expiry(exchange["expires_at"])
        except (KeyError, TypeError, ValueError):
            raise ModelError("Qoder returned an invalid job-token expiry") from None
        if not isinstance(token, str) or not token or expires <= time.time():
            raise ModelError("Qoder returned invalid job-token credentials")
        user = self._request_json(
            "GET", OPENAPI + "/api/v1/userinfo", headers={"Authorization": "Bearer " + token}
        )
        if not isinstance(user.get("id"), str) or not user["id"]:
            raise ModelError("Qoder returned no account identity")
        self._auth = {
            "token": token, "uid": user["id"], "name": user.get("name") or "",
            "email": user.get("email") or "", "organization": user.get("organization_id") or "",
            "expires": expires,
        }
        return self._auth

    def list_models(self) -> List[Dict[str, Any]]:
        with self._lock:
            auth = self._credentials()
            if time.time() >= self._catalog_until:
                url = self.base_url + "/algo/api/v2/model/list?Encode=1"
                catalog = self._request_json("GET", url, headers=self._sign(url, b"", auth))
                entries = catalog.get("assistant")
                if not isinstance(entries, list):
                    raise ModelError("Qoder returned an invalid model catalog")
                enabled = [entry for entry in entries if isinstance(entry, dict)
                           and entry.get("enable") is True and isinstance(entry.get("key"), str)
                           and entry["key"]]
                if not enabled:
                    raise ModelError("Qoder returned no enabled assistant models")
                self._catalog = enabled
                self._catalog_until = time.time() + 300
            return copy.deepcopy(self._catalog)

    def _sign(self, url: str, body: bytes, auth: Dict[str, Any]) -> Dict[str, str]:
        try:
            from cryptography.hazmat.primitives import padding as symmetric_padding
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            from cryptography.hazmat.primitives.serialization import load_pem_public_key
            from cryptography.hazmat.primitives.asymmetric import padding as rsa_padding
        except ImportError:
            raise ModelError("Qoder backend requires cryptography; install requirements-qoder.txt") from None

        request_id = str(uuid.uuid4())
        key = request_id.replace("-", "")[:16].encode("ascii")
        identity = _json_bytes({
            "uid": auth["uid"], "security_oauth_token": auth["token"],
            "name": auth["name"], "email": auth["email"], "aid": "",
        })
        padder = symmetric_padding.PKCS7(128).padder()
        encrypted_input = padder.update(identity) + padder.finalize()
        encryptor = Cipher(algorithms.AES(key), modes.CBC(key)).encryptor()
        encrypted = encryptor.update(encrypted_input) + encryptor.finalize()
        public_key = load_pem_public_key(PUBLIC_KEY)
        wrapped_key = public_key.encrypt(key, rsa_padding.PKCS1v15())
        cosy_key = base64.b64encode(wrapped_key).decode("ascii")
        payload = _json_bytes({
            "version": "v1", "requestId": request_id,
            "info": base64.b64encode(encrypted).decode("ascii"),
            "cosyVersion": COSY_VERSION, "ideVersion": "",
        })
        payload_b64 = base64.b64encode(payload).decode("ascii")
        date = str(int(time.time()))
        path = urllib.parse.urlsplit(url).path.removeprefix("/algo")
        digest = hashlib.md5(
            payload_b64.encode() + b"\n" + cosy_key.encode() + b"\n" + date.encode()
            + b"\n" + body + b"\n" + path.encode()
        ).hexdigest()
        headers = {
            "Authorization": "Bearer COSY." + payload_b64 + "." + digest,
            "Cosy-Key": cosy_key, "Cosy-Date": date, "Cosy-User": auth["uid"],
            "Cosy-Version": COSY_VERSION, "Cosy-Machineid": self.machine_id,
            "Cosy-Machinetoken": self.machine_id, "Cosy-Machinetype": "5",
            "Cosy-Clienttype": "5", "Cosy-Data-Policy": "disagree",
            "Login-Version": "v2", "Cosy-Scene": "assistant",
            "Cosy-Business-Product": "cli", "Cosy-Business-Type": "agent",
        }
        if auth["organization"]:
            headers["Cosy-Organization-Id"] = auth["organization"]
        return headers

    def complete(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> Completion:
        if not self.model:
            raise ValueError("Qoder model is required; list models first")
        catalog = self.list_models()
        selected = next((entry for entry in catalog if self.model in
                         (entry["key"], entry.get("display_name"))), None)
        if selected is None:
            raise ModelError("selected model is not in the enabled Qoder account catalog")
        with self._lock:
            auth = self._credentials()
        request_id = str(uuid.uuid4())
        replay = []
        for message in messages:
            item = {key: value for key, value in message.items() if value is not None}
            if item.get("role") == "assistant" and item.get("tool_calls") and not item.get("content"):
                item["content"] = " "
            replay.append(item)
        body = _json_bytes({
            "request_id": request_id, "request_set_id": request_id,
            "chat_record_id": request_id, "session_id": self.session_id,
            "stream": True, "chat_task": "FREE_INPUT", "is_reply": True,
            "is_retry": False, "source": 1, "version": "3",
            "session_type": "qodercli", "agent_id": "agent_common", "task_id": "common",
            "system": "", "messages": replay, "tools": tools,
            "parameters": {}, "model_config": selected,
            "business": {"product": "cli", "version": "1.0.0", "type": "agent",
                         "stage": "start", "id": request_id, "name": "glass-agent",
                         "begin_at": int(time.time() * 1000)},
        })
        encoded = _encode_body(body)
        url = self.base_url + CHAT_PATH + CHAT_QUERY
        headers = self._sign(url, encoded, auth)
        headers.update({
            "Accept": "text/event-stream", "Content-Type": "application/json",
            "X-Model-Key": selected["key"], "X-Model-Source": str(selected.get("source") or ""),
        })
        request = urllib.request.Request(url, data=encoded, headers=headers, method="POST")
        with self._open(request) as response:
            return self._read_stream(response)

    @staticmethod
    def _read_stream(response: Any) -> Completion:
        content = ""
        calls: Dict[int, Dict[str, Any]] = {}
        finish_reason = None
        done = False
        total_bytes = 0
        for raw_line in response:
            total_bytes += len(raw_line)
            if total_bytes > 8 * 1024 * 1024:
                raise ModelError("Qoder stream is too large")
            try:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data:"):
                    if line == "event: error":
                        raise ModelError("Qoder stream returned an error")
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    done = True
                    break
                envelope = json.loads(data)
                if envelope.get("statusCodeValue") not in (None, 0, 200):
                    raise ModelError("Qoder stream returned a gateway error")
                body = envelope["body"]
                if body == "[DONE]":
                    done = True
                    break
                if isinstance(body, str):
                    body = json.loads(body)
                if not isinstance(body, dict) or body.get("error") or body.get("code") not in (None, 0, "0"):
                    raise ModelError("Qoder stream returned a model error")
                choices = body.get("choices") or []
                if not choices:
                    continue
                choice = choices[0]
                delta = choice.get("delta") or {}
                content += delta.get("content") or ""
                for part in delta.get("tool_calls") or []:
                    index = part["index"]
                    if not isinstance(index, int) or index < 0 or index > 1023:
                        raise ModelError("Qoder returned an invalid tool index")
                    call = calls.setdefault(index, {"id": "", "type": "function",
                                                    "function": {"name": "", "arguments": ""}})
                    if part.get("id"):
                        if call["id"] and call["id"] != part["id"]:
                            raise ModelError("Qoder changed an active tool call ID")
                        call["id"] = part["id"]
                    function = part.get("function") or {}
                    if function.get("name"):
                        call["function"]["name"] = function["name"]
                    call["function"]["arguments"] += function.get("arguments") or ""
                if choice.get("finish_reason"):
                    finish_reason = choice["finish_reason"]
            except (UnicodeError, ValueError, KeyError, TypeError, AttributeError):
                raise ModelError("Qoder returned an invalid stream event") from None
        if not done or finish_reason is None:
            raise ModelError("Qoder stream ended before inference completed")
        ordered = []
        for index in sorted(calls):
            call = calls[index]
            try:
                arguments = json.loads(call["function"]["arguments"])
            except ValueError:
                raise ModelError("Qoder returned incomplete tool arguments") from None
            if not call["id"] or not call["function"]["name"] or not isinstance(arguments, dict):
                raise ModelError("Qoder returned an incomplete tool call")
            ordered.append(call)
        if finish_reason == "tool_calls" and not ordered:
            raise ModelError("Qoder indicated tool calls but returned none")
        if not content.strip() and not ordered:
            raise ModelError("Qoder returned an empty response")
        message = {"role": "assistant", "content": content or None}
        if ordered:
            message["tool_calls"] = ordered
        return Completion(message, finish_reason)
