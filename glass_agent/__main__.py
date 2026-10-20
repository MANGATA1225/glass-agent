"""Run with: python3 -m glass_agent 'your question'."""

import argparse
import os
import sys
from pathlib import Path

from .core import Agent, AgentError
from .provider import ChatCompletionsModel, ModelError
from .tools import workspace_tools


def main() -> int:
    parser = argparse.ArgumentParser(description="Minimal read-only workspace agent")
    parser.add_argument("prompt", nargs="*", help="Question; omit for interactive mode")
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--model", default=os.getenv("GLASS_MODEL", "gpt-4.1-mini"))
    parser.add_argument("--base-url", default=os.getenv("GLASS_BASE_URL", "https://api.openai.com/v1"))
    parser.add_argument("--max-steps", type=int, default=8)
    args = parser.parse_args()
    try:
        model = ChatCompletionsModel(
            api_key=os.getenv("OPENAI_API_KEY", ""), model=args.model, base_url=args.base_url
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
