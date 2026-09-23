"""Shared-fixture conformance for the Python port of the skill decision."""
import json
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from system_one.decision import select_skill  # noqa: E402

ASSETS = Path(__file__).resolve().parents[1] / "system_one" / "assets"


def replay(calls, made):
    def ask(_state, _questions):
        index = made["count"]
        made["count"] += 1
        if index >= len(calls):
            raise AssertionError("fixture provided no answer for this call")
        call = calls[index]
        if call.get("throw"):
            raise RuntimeError("fixture transport error")
        return call.get("answers", {})

    return ask


class ConformanceTest(unittest.TestCase):
    def test_shared_fixtures(self):
        fixtures = [
            json.loads(line)
            for line in (ASSETS / "conformance.jsonl").read_text().splitlines()
            if line.strip()
        ]
        self.assertEqual(len(fixtures), 9)
        failures = []
        for fixture in fixtures:
            self.assertEqual(fixture["decision"], "skills")
            roster = [
                {
                    "id": entry["id"],
                    "name": entry.get("name", entry["id"]),
                    "description": entry.get("description"),
                    "content": entry.get("content", ""),
                }
                for entry in fixture["roster"]
            ]
            made = {"count": 0}
            actual = select_skill(replay(fixture["calls"], made), fixture["task"], roster)
            if actual != fixture["expected"]["skill"]:
                failures.append(f"{fixture['id']}: expected {fixture['expected']['skill']!r}, got {actual!r}")
                continue
            if made["count"] != len(fixture["calls"]):
                failures.append(f"{fixture['id']}: expected {len(fixture['calls'])} ask call(s), made {made['count']}")
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
