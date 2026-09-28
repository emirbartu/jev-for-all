"""Usage observation: off by default, one usage line per user message, recorder never raises."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import system_one as plugin  # noqa: E402
from system_one import decision  # noqa: E402

USAGE_LINE = {
    "kind": "usage",
    "harness": "hermes",
    "sessionID": "s1",
    "messageID": "turn-1",
    "agent": "cli",
    "model": "hermes-model",
    "input": 0,
    "output": 0,
    "reasoning": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
}


class ObserveTest(unittest.TestCase):
    """The registered pre_llm_call hook is the recorder's only entry point."""

    def setUp(self):
        self.hooks = {}
        self.config = {}
        self.jev_calls = []
        hooks = self.hooks
        config = self.config
        jev_calls = self.jev_calls

        class Ctx:
            def get_config(self, key, default=None):
                return config.get(key, default)

            def register_hook(self, name, callback):
                hooks[name] = callback

        self.ctx = Ctx()
        plugin.register(self.ctx)

    def _turn(self, data_dir, config=None, *, turn_id="turn-1", user_message="hi"):
        """One pre_llm_call with an empty roster and no API key: no Jev call, no network."""
        self.config.clear()
        self.config.update({"skill_dirs": [str(Path(data_dir) / "skills")]})
        self.config.update(config or {})
        call = {
            "session_id": "s1",
            "user_message": user_message,
            "conversation_history": [],
            "is_first_turn": True,
            "model": "hermes-model",
            "platform": "cli",
        }
        if turn_id is not None:
            call["turn_id"] = turn_id
        with mock.patch.object(plugin, "_plugin_data_dir", lambda: Path(data_dir)), mock.patch.dict(
            os.environ, {"OPENROUTER_API_KEY": ""}, clear=False
        ), mock.patch.object(decision, "ask_openrouter", lambda *args, **kwargs: jev_calls.append(1) or {}):
            return self.hooks["pre_llm_call"](**call)

    def _lines(self, data_dir):
        log = Path(data_dir) / "decisions.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]

    def test_one_usage_line_per_user_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(self._turn(tmp, {"observe": True}))
            lines = self._lines(tmp)
            self.assertEqual(len(lines), 1)
            record = dict(lines[0])
            self.assertIsInstance(record.pop("time"), float)
            self.assertEqual(record, USAGE_LINE)

            # A second user message appends a second line.
            self._turn(tmp, {"observe": True}, turn_id="turn-2")
            lines = self._lines(tmp)
            self.assertEqual([line["kind"] for line in lines], ["usage", "usage"])
            self.assertEqual([line["messageID"] for line in lines], ["turn-1", "turn-2"])
            self.assertEqual(self.jev_calls, [])

    def test_observe_is_off_by_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(self._turn(tmp))
            self.assertIsNone(self._turn(tmp, {"observe": False}))
            self.assertFalse((Path(tmp) / "decisions.jsonl").exists())

        class Ctx:
            def __init__(self, config):
                self.config = config

            def get_config(self, key, default=None):
                return self.config.get(key, default)

        self.assertFalse(plugin._observe_enabled(Ctx({})))
        self.assertTrue(plugin._observe_enabled(Ctx({"observe": True})))
        self.assertFalse(plugin._observe_enabled(Ctx({"observe": False})))

    def test_usage_record_guards_non_numeric_counts(self):
        record = decision.usage_from_message(
            session_id="s1",
            message_id="turn-1",
            time_s=float("nan"),
            input_tokens="12",
            output_tokens=3,
            reasoning_tokens=True,
            cache_read_tokens=1.5,
        )
        self.assertEqual(record["input"], 0)
        self.assertEqual(record["output"], 3)
        self.assertEqual(record["reasoning"], 0)
        self.assertEqual(record["cacheRead"], 1.5)
        self.assertEqual(record["cacheWrite"], 0)
        self.assertEqual(record["time"], 0)
        self.assertEqual(record["agent"], "?")

    def test_message_id_falls_back_to_a_digest(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(self._turn(tmp, {"observe": True}, turn_id=None))
            self.assertEqual(self._lines(tmp)[0]["messageID"], plugin._message_id("hi"))

    def test_usage_lines_are_not_counted_as_jev_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "decisions.jsonl"
            self._turn(tmp, {"observe": True})
            log.write_text(
                log.read_text()
                + json.dumps({"kind": "decision", "harness": "hermes", "sessionID": "s1", "hook": "pre_llm_call"}) + "\n"
            )
            self.config.clear()
            self.config.update({"max_calls_per_session": 2})
            self.assertEqual(plugin._session_budget(self.ctx, session_id="s1", hook="pre_llm_call", log_path=log), 1)

    def test_recorder_failure_never_reaches_the_turn(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(decision, "log_usage", side_effect=RuntimeError("boom")):
                self.assertIsNone(self._turn(tmp, {"observe": True}))

            # A log path the OS refuses: a plain file where the log's directory would have to be.
            blocked = Path(tmp) / "blocked"
            blocked.write_text("not a directory")
            self.assertIsNone(self._turn(str(blocked), {"observe": True}))
            self.assertFalse((Path(tmp) / "decisions.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
