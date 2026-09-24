"""Decision rules, injection cap, roster scan, transport fail-open, plugin registration."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from system_one import decision  # noqa: E402

OPEN_GATE = {
    "gate::acts": {"type": "noul", "noul": 0.9},
    "gate::procedure": {"type": "noul", "noul": 0.8},
    "gate::prose": {"type": "noul", "noul": 0.2},
    "gate::advisory": {"type": "noul", "noul": 0.5},
}


def stub_ask(*responses):
    calls = []

    def ask(_state, _questions):
        calls.append((_state, _questions))
        response = responses[min(len(calls) - 1, len(responses) - 1)]
        if isinstance(response, Exception):
            raise response
        return response

    return ask, calls


class DecisionTest(unittest.TestCase):
    def test_skill_none_and_no_change(self):
        roster = [{"id": "a", "name": "A", "description": "Does A", "content": "body"}]
        ask, _ = stub_ask(
            {
                "which": {"type": "choice", "choice": "a", "probabilities": {"a": 0.9}, "confidence": 0.9},
                **OPEN_GATE,
            }
        )
        self.assertEqual(decision.decide(ask, "do A", roster), ("skill", "a"))

        ask, _ = stub_ask(
            {
                "which": {"type": "choice", "choice": "a", "probabilities": {"a": 0.9}, "confidence": 0.9},
                "gate::acts": {"type": "noul", "noul": 0.1},
                "gate::procedure": {"type": "noul", "noul": 0.1},
                "gate::prose": {"type": "noul", "noul": 0.9},
                "gate::advisory": {"type": "noul", "noul": 0.1},
            }
        )
        self.assertEqual(decision.decide(ask, "explain", roster), ("none", None))

        ask, _ = stub_ask(RuntimeError("boom"))
        self.assertEqual(decision.decide(ask, "do A", roster), ("no-change", None))

        ask, _ = stub_ask(
            {
                "which": {"type": "choice", "choice": "a", "probabilities": {"a": 0.5}, "confidence": 0.1},
                **OPEN_GATE,
            }
        )
        self.assertEqual(decision.decide(ask, "do A", roster), ("no-change", None))

    def test_injection_cap_and_none_line(self):
        short = decision.injection_for({"id": "a", "name": "A", "description": "Does A", "content": "body", "path": "/s/a"})
        self.assertIn("body", short)
        long = decision.injection_for(
            {"id": "b", "name": "B", "description": "Does B", "content": "x" * 8001, "path": "/s/b"}
        )
        self.assertIn("/s/b", long)
        self.assertNotIn("x" * 8001, long)
        self.assertIn("routed externally", decision.NONE_CONTEXT)

    def test_scan_skills(self):
        with tempfile.TemporaryDirectory() as root:
            skill = Path(root) / "alpha"
            skill.mkdir()
            (skill / "SKILL.md").write_text("---\nname: Alpha\ndescription: Does alpha\n---\n\nAlpha body\n")
            broken = Path(root) / "broken"
            broken.mkdir()
            (broken / "SKILL.md").write_text("no frontmatter")
            skills = {entry["id"]: entry for entry in decision.scan_skills([root])}
            self.assertEqual(skills["alpha"]["name"], "Alpha")
            self.assertEqual(skills["alpha"]["description"], "Does alpha")
            self.assertEqual(skills["alpha"]["content"].strip(), "Alpha body")
            self.assertEqual(skills["broken"]["name"], "broken")

    def test_scan_skills_nested_categories(self):
        with tempfile.TemporaryDirectory() as root:
            top = Path(root) / "top-skill"
            top.mkdir()
            (top / "SKILL.md").write_text("---\nname: Top\ndescription: Top skill\n---\n\nTop body\n")
            category = Path(root) / "category"
            category.mkdir()
            (category / "DESCRIPTION.md").write_text("Category blurb, not a skill\n")
            nested = category / "nested-skill"
            nested.mkdir()
            (nested / "SKILL.md").write_text("---\nname: Nested\ndescription: Nested skill\n---\n\nNested body\n")
            docs = Path(root) / "docs"
            docs.mkdir()
            (docs / "notes.md").write_text("no skill here\n")
            hidden = Path(root) / ".hidden"
            hidden.mkdir()
            (hidden / "SKILL.md").write_text("---\nname: Hidden\n---\n\nHidden body\n")
            hidden_nested = category / ".hidden-skill"
            hidden_nested.mkdir()
            (hidden_nested / "SKILL.md").write_text("---\nname: Hidden nested\n---\n\nHidden body\n")
            skills = decision.scan_skills([root])
            self.assertEqual([entry["id"] for entry in skills], ["top-skill", "nested-skill"])
            by_id = {entry["id"]: entry for entry in skills}
            self.assertEqual(set(by_id["nested-skill"]), {"id", "name", "description", "content", "path"})
            self.assertEqual(by_id["nested-skill"]["name"], "Nested")
            self.assertEqual(by_id["nested-skill"]["description"], "Nested skill")
            self.assertEqual(by_id["nested-skill"]["content"].strip(), "Nested body")
            self.assertEqual(by_id["nested-skill"]["path"], str(nested / "SKILL.md"))
            self.assertEqual(by_id["top-skill"]["path"], str(top / "SKILL.md"))

    def test_scan_skills_dedupe_top_level_wins(self):
        with tempfile.TemporaryDirectory() as root:
            top = Path(root) / "same"
            top.mkdir()
            (top / "SKILL.md").write_text("---\nname: Top\ndescription: Top level\n---\n\nTop body\n")
            category = Path(root) / "aaa"
            category.mkdir()
            nested = category / "same"
            nested.mkdir()
            (nested / "SKILL.md").write_text("---\nname: Nested\ndescription: Nested\n---\n\nNested body\n")
            skills = decision.scan_skills([root])
            self.assertEqual([entry["id"] for entry in skills], ["same"])
            self.assertEqual(skills[0]["name"], "Top")
            self.assertEqual(skills[0]["path"], str(top / "SKILL.md"))

    def test_folded_and_literal_descriptions_are_parsed(self):
        folded = decision._parse_frontmatter(
            "---\nname: ponytail\ndescription: >\n  Forces the laziest solution,\n  simplest and most minimal.\n---\n\nbody\n"
        )
        self.assertEqual(folded["description"], "Forces the laziest solution, simplest and most minimal.")
        literal = decision._parse_frontmatter("---\nname: x\ndescription: |\n  line one\n  line two\n---\nbody")
        self.assertEqual(literal["description"], "line one\nline two")
        plain = decision._parse_frontmatter("---\nname: y\ndescription: does y\n---\nbody")
        self.assertEqual(plain["description"], "does y")

    def test_advisory_work_opens_the_gate(self):
        roster = [{"id": "brainstorming", "name": "brainstorming", "description": "Explore intent", "content": "x"}]
        low_act_gate = {
            "gate::acts": {"type": "noul", "noul": 0.03},
            "gate::procedure": {"type": "noul", "noul": 0.2},
            "gate::prose": {"type": "noul", "noul": 0.8},
        }
        ask, _ = stub_ask(
            {
                "which": {
                    "type": "choice",
                    "choice": "brainstorming",
                    "probabilities": {"brainstorming": 0.8},
                    "confidence": 0.9,
                },
                **low_act_gate,
                "gate::advisory": {"type": "noul", "noul": 0.9},
            }
        )
        self.assertEqual(
            decision.select_skill(ask, "help me figure out what this app should do", roster), "brainstorming"
        )

        ask, _ = stub_ask(
            {
                "which": {
                    "type": "choice",
                    "choice": "brainstorming",
                    "probabilities": {"brainstorming": 0.8},
                    "confidence": 0.9,
                },
                **low_act_gate,
                "gate::advisory": {"type": "noul", "noul": 0.1},
            }
        )
        self.assertIsNone(decision.select_skill(ask, "rename x to count", roster))

    def test_decide_treats_a_missing_advisory_answer_as_no_change(self):
        roster = [{"id": "a", "name": "A", "description": "Does A", "content": "body"}]
        ask, _ = stub_ask(
            {
                "which": {"type": "choice", "choice": "a", "probabilities": {"a": 0.9}, "confidence": 0.9},
                "gate::acts": {"type": "noul", "noul": 0.9},
                "gate::procedure": {"type": "noul", "noul": 0.8},
                "gate::prose": {"type": "noul", "noul": 0.2},
            }
        )
        self.assertEqual(decision.decide(ask, "do A", roster), ("no-change", None))

    def test_verification_gate_states(self):
        control = decision.POLICY["control"]
        hint = control["hint"]

        def answers(claim, ran, passed):
            return stub_ask(
                {
                    "control::claim": {"type": "noul", "noul": claim},
                    "control::ran": {"type": "noul", "noul": ran},
                    "control::passed": {"type": "noul", "noul": passed},
                }
            )

        # No run: completion claimed, no check at all → nudge.
        ask, calls = answers(0.9, 0.1, 0.1)
        self.assertEqual(
            decision.decide_verification(ask, response="All done.", changed_paths=["src/a.py"]), hint
        )
        self.assertEqual(calls[0][0], {"tail": "assistant: All done.\nchanged: src/a.py"})
        self.assertEqual(calls[0][1]["control::claim"]["instructions"], control["questions"]["claim"])

        # Red run: a check ran but failed → nudge.
        ask, _ = answers(0.9, 0.9, 0.1)
        self.assertEqual(decision.decide_verification(ask, response="Fixed it.", changed_paths=[]), hint)

        # Stale run: ran before the change, so it did not pass for this change → nudge.
        ask, _ = answers(0.9, 0.9, 0.4)
        self.assertEqual(decision.decide_verification(ask, response="Finished.", changed_paths=[]), hint)

        # Green run: check ran and passed → hold.
        ask, _ = answers(0.9, 0.9, 0.9)
        self.assertIsNone(decision.decide_verification(ask, response="Complete.", changed_paths=[]))

        # Config override: a higher claim floor turns the claim into a hold.
        ask, _ = answers(0.9, 0.1, 0.1)
        self.assertIsNone(
            decision.decide_verification(ask, response="Done.", changed_paths=[], config={"claimMin": 0.95})
        )

    def test_verification_gate_skips_non_claims_and_fails_open(self):
        noisy = {
            "control::claim": {"type": "noul", "noul": 0.9},
            "control::ran": {"type": "noul", "noul": 0.1},
            "control::passed": {"type": "noul", "noul": 0.1},
        }
        # Not a completion claim → no Jev call at all.
        ask, calls = stub_ask(noisy)
        self.assertIsNone(
            decision.decide_verification(ask, response="Here is what I found in the file.", changed_paths=[])
        )
        self.assertEqual(calls, [])

        # Jev says it is not a completion claim → hold.
        ask, _ = stub_ask(
            {
                "control::claim": {"type": "noul", "noul": 0.2},
                "control::ran": {"type": "noul", "noul": 0.1},
                "control::passed": {"type": "noul", "noul": 0.1},
            }
        )
        self.assertIsNone(decision.decide_verification(ask, response="Done.", changed_paths=[]))

        # Malformed or partial answer → hold.
        ask, _ = stub_ask({"control::claim": {"type": "noul"}})
        self.assertIsNone(decision.decide_verification(ask, response="Done.", changed_paths=[]))

        # Transport error / timeout → hold.
        ask, _ = stub_ask(TimeoutError("slow"))
        self.assertIsNone(decision.decide_verification(ask, response="Done.", changed_paths=[]))

    def test_transport_parses_answers_and_reports_meta(self):
        class FakeResponse:
            def __init__(self, body):
                self.body = body

            def read(self):
                return json.dumps(self.body).encode()

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        original = decision.urllib.request.urlopen
        meta = {}

        def fake_urlopen(request, timeout=None):
            return FakeResponse(
                {
                    "answers": {"which": {"type": "choice", "choice": "a", "probabilities": {"a": 1}, "confidence": 1}},
                    "model": "~typesafe/jev-1.13.0",
                    "usage": {"input_tokens": 12, "output_tokens": 3},
                }
            )

        decision.urllib.request.urlopen = fake_urlopen
        try:
            answers = decision.ask_openrouter(
                {"request": "hi"},
                {"which": {"type": "choice", "instructions": "pick", "criteria": {"a": "A"}}},
                api_key="k",
                model="~typesafe/jev-latest",
                timeout_s=1,
                on_meta=lambda info: meta.update(info),
            )
        finally:
            decision.urllib.request.urlopen = original
        self.assertEqual(answers["which"]["choice"], "a")
        self.assertEqual(meta["model"], "~typesafe/jev-1.13.0")
        self.assertEqual(meta["input_tokens"], 12)

    def test_unparseable_first_answer_is_no_change(self):
        roster = [{"id": "a", "name": "A", "description": "Does A", "content": "body"}]
        ask, _ = stub_ask({})
        self.assertEqual(decision.decide(ask, "do A", roster), ("no-change", None))

        ask, _ = stub_ask({"which": {"type": "choice", "choice": 7}, **OPEN_GATE})
        self.assertEqual(decision.decide(ask, "do A", roster), ("no-change", None))

        ask, _ = stub_ask(
            {
                "which": {"type": "choice", "choice": "a", "probabilities": {"a": 0.9}, "confidence": 0.9},
                "gate::acts": {"type": "noul"},
                "gate::procedure": {"type": "noul", "noul": 0.8},
                "gate::prose": {"type": "noul", "noul": 0.2},
            }
        )
        self.assertEqual(decision.decide(ask, "do A", roster), ("no-change", None))


class VerifyHookTest(unittest.TestCase):
    """pre_verify handler: off by default, one nudge per turn, logged, fail-open."""

    def setUp(self):
        import importlib

        import system_one as plugin

        self.plugin = plugin
        importlib.reload(plugin)

    class Ctx:
        def __init__(self, config=None):
            self.config = config or {}

        def get_config(self, key, default=None):
            return self.config.get(key, default)

    def _run(self, tmp, config, *, response="All tests pass.", attempt=0, changed_paths=("src/a.py",), ask=None):
        with mock.patch.object(self.plugin, "_plugin_data_dir", lambda: Path(tmp)), mock.patch.dict(
            os.environ, {"OPENROUTER_API_KEY": "k"}, clear=False
        ), mock.patch.object(decision, "ask_openrouter", ask or (lambda *args, **kwargs: {})):
            return self.plugin._handle_verify(
                self.Ctx(config),
                session_id="s",
                attempt=attempt,
                final_response=response,
                changed_paths=list(changed_paths),
            )

    def test_verify_hook_is_off_by_default_and_self_throttles(self):
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(self._run(tmp, {}, ask=lambda *a, **k: calls.append(1) or {}))
            self.assertIsNone(self._run(tmp, {"verify": True}, attempt=1, ask=lambda *a, **k: calls.append(1) or {}))
            self.assertEqual(calls, [])

    def test_verify_hook_nudges_once_and_logs(self):
        answers = {
            "control::claim": {"type": "noul", "noul": 0.9},
            "control::ran": {"type": "noul", "noul": 0.1},
            "control::passed": {"type": "noul", "noul": 0.1},
        }
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run(tmp, {"verify": True}, ask=lambda *a, **k: answers)
            self.assertEqual(result, {"action": "continue", "message": decision.POLICY["control"]["hint"]})
            record = json.loads((Path(tmp) / "decisions.jsonl").read_text().splitlines()[0])
            self.assertEqual(record["hook"], "pre_verify")
            self.assertEqual(record["chosen"], "nudge")

            # A green run holds: the handler stays out of the way.
            green = {
                "control::claim": {"type": "noul", "noul": 0.9},
                "control::ran": {"type": "noul", "noul": 0.9},
                "control::passed": {"type": "noul", "noul": 0.9},
            }
            self.assertIsNone(self._run(tmp, {"verify": True}, ask=lambda *a, **k: green))

    def test_verify_hook_fails_open_on_transport_error(self):
        def boom(*args, **kwargs):
            raise TimeoutError("slow")

        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(self._run(tmp, {"verify": True}, ask=boom))

    def test_verify_hook_respects_the_session_call_cap(self):
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "decisions.jsonl").write_text('{"kind": "decision", "sessionID": "s"}\n')
            result = self._run(
                tmp,
                {"verify": True, "max_calls_per_session": 1},
                ask=lambda *a, **k: calls.append(1) or {},
            )
            self.assertIsNone(result)
            self.assertEqual(calls, [])
            records = [json.loads(line) for line in (Path(tmp) / "decisions.jsonl").read_text().splitlines()]
            self.assertEqual(records[-1]["event"], "cap")
            self.assertEqual(records[-1]["hook"], "pre_verify")


class PluginRegistrationTest(unittest.TestCase):
    def test_register_wires_both_hooks_and_returns_context(self):
        import importlib
        import os
        import tempfile
        from unittest import mock

        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"HERMES_HOME": home}, clear=False):
            os.environ.pop("OPENROUTER_API_KEY", None)
            import system_one as plugin

            importlib.reload(plugin)

            hooks = {}

            class FakeCtx:
                def register_hook(self, name, callback):
                    hooks[name] = callback

                def get_config(self):
                    return {}

            plugin.register(FakeCtx())
            self.assertEqual(list(hooks), ["pre_llm_call", "pre_verify"])
            self.assertIsNone(
                hooks["pre_llm_call"](
                    session_id="s",
                    user_message="hi",
                    conversation_history=[],
                    is_first_turn=True,
                    model="m",
                    platform="cli",
                )
            )
            self.assertIsNone(
                hooks["pre_verify"](
                    session_id="s",
                    platform="cli",
                    model="m",
                    coding=True,
                    attempt=0,
                    final_response="Done.",
                    changed_paths=["a.py"],
                )
            )


if __name__ == "__main__":
    unittest.main()
