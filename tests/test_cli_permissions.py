import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from glass_agent.__main__ import main
from glass_agent.core import Completion


class FakeModel:
    model = "fake-model"

    def complete(self, _messages, _tools):
        return Completion({"content": "done"}, "stop")


class CLIPermissionTests(unittest.TestCase):
    def test_default_run_does_not_write_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = ["glass-agent", "--workspace", str(root), "hello"]
            with patch("sys.argv", args), patch("glass_agent.__main__.ChatCompletionsModel", return_value=FakeModel()), \
                    patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(main(), 0)
            self.assertFalse((root / ".glass-agent").exists())

    def test_save_requires_explicit_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = ["glass-agent", "--workspace", str(root), "--save", "hello"]
            with patch("sys.argv", args), patch("glass_agent.__main__.ChatCompletionsModel", return_value=FakeModel()), \
                    patch("sys.stdout", new_callable=io.StringIO), patch("sys.stderr", new_callable=io.StringIO):
                self.assertEqual(main(), 0)
            self.assertEqual(len(list((root / ".glass-agent" / "sessions").glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
