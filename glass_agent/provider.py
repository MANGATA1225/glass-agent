"""OpenAI-compatible Chat Completions transport using only the standard library."""

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List

from .core import Completion


class ModelError(Exception):
    """The model API request or response failed."""


class ChatCompletionsModel:
    def __init__(
        self,
        api_key: str,
        model: str = "gpt-4.1-mini",
        base_url: str = "https://api.openai.com/v1",
        timeout: float = 60,
    ) -> None:
        if not api_key:
            raise ValueError("OPENAI_API_KEY is required")
        parsed = urllib.parse.urlsplit(base_url)
        local_hosts = ("localhost", "127.0.0.1", "::1")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in local_hosts):
            raise ValueError("base URL must use HTTPS (HTTP is allowed for localhost)")
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("base URL must not contain credentials, query, or fragment")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.api_key = api_key
        self.model = model
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.timeout = timeout

    def complete(self, messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> Completion:
        payload: Dict[str, Any] = {"model": self.model, "messages": messages}
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        request = urllib.request.Request(
            self.url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": "Bearer " + self.api_key,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                data = json.load(response)
        except urllib.error.HTTPError as exc:
            raise ModelError("model API returned HTTP " + str(exc.code)) from None
        except (urllib.error.URLError, TimeoutError, ValueError) as exc:
            raise ModelError("model API request failed: " + type(exc).__name__) from None
        try:
            choice = data["choices"][0]
            message = choice["message"]
            if not isinstance(message, dict):
                raise TypeError
            return Completion(message=message, finish_reason=choice.get("finish_reason"))
        except (KeyError, IndexError, TypeError) as exc:
            raise ModelError("model API returned an invalid response") from exc
