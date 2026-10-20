"""A small, dependency-free tool-calling agent."""

from .core import Agent, AgentError, StepLimitExceeded, Tool
from .provider import ChatCompletionsModel, ModelError
from .tools import workspace_tools

__all__ = [
    "Agent",
    "AgentError",
    "StepLimitExceeded",
    "Tool",
    "ChatCompletionsModel",
    "ModelError",
    "workspace_tools",
]
