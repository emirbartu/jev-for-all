"""Decision rules, injection cap, roster scan, transport fail-open, plugin registration."""
import json
import os
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from system_one import decision  # noqa: E402

OPEN_GATE = {
    "gate::acts": {"type": "noul", "noul": 0.9},
    "gate::procedure": {"type": "noul", "noul": 0.8},
    "gate::prose": {"type": "noul", "noul": 0.2},
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


class PluginRegistrationTest(unittest.TestCase):
    def test_register_wires_only_pre_llm_call_and_returns_context(self):
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
            self.assertEqual(list(hooks), ["pre_llm_call"])
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


if __name__ == "__main__":
    unittest.main()
