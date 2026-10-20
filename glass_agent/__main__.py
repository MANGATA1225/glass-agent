"""Run with: python3 -m glass_agent 'your question'."""

import argparse
import os
import sys
from pathlib import Path

from .core import Agent, AgentError
from .provider import ChatCompletionsModel, ModelError
from .qoder import OFFICIAL_ENDPOINTS, QoderModel
from .tools import workspace_tools


def main() -> int:
    parser = argparse.ArgumentParser(prog="glass-agent", description="Minimal read-only workspace agent")
    parser.add_argument("prompt", nargs="*", help="Question; omit for interactive mode")
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--provider", choices=("openai", "qoder"),
                        default=os.getenv("GLASS_PROVIDER", "openai"))
    parser.add_argument("--model", default=os.getenv("GLASS_MODEL"))
    parser.add_argument("--base-url", help="OpenAI API root or official Qoder model endpoint")
    parser.add_argument("--list-models", action="store_true", help="list enabled Qoder account models")
    parser.add_argument("--max-steps", type=int, default=8)
    args = parser.parse_args()
    try:
        if args.provider == "qoder":
            model = QoderModel(
                pat=os.getenv("QODER_PERSONAL_ACCESS_TOKEN", ""), model=args.model,
                base_url=args.base_url or os.getenv("QODER_BASE_URL", OFFICIAL_ENDPOINTS[0]),
            )
            if args.list_models:
                for item in model.list_models():
                    print(item["key"] + "\t" + str(item.get("display_name") or ""))
                return 0
            if not args.model:
                raise ValueError("Qoder requires --model; run --provider qoder --list-models")
        else:
            if args.list_models:
                raise ValueError("--list-models is supported only for Qoder")
            model = ChatCompletionsModel(
                api_key=os.getenv("OPENAI_API_KEY", ""),
                model=args.model or "gpt-4.1-mini",
                base_url=args.base_url or os.getenv("GLASS_BASE_URL", "https://api.openai.com/v1"),
            )
        agent = Agent(model, workspace_tools(args.workspace), max_steps=args.max_steps)
        if args.prompt:
            print(agent.run(" ".join(args.prompt)))
            return 0
        while True:
            try:
                prompt = input("glass> ")
            except (EOFError, KeyboardInterrupt):
                print()
                return 0
            if prompt.strip().lower() in ("exit", "quit"):
                return 0
            if prompt.strip():
                print(agent.run(prompt))
    except (AgentError, ModelError, OSError, ValueError) as exc:
        print("error: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
