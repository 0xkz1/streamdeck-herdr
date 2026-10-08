"""Run with: python3 -B streamdeck-herdr/test_limit_watch.py -v"""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timedelta

spec = importlib.util.spec_from_file_location("limit_watch", Path(__file__).with_name("limit_watch.py"))
lw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lw)


class FindHitTests(unittest.TestCase):
    def test_codex_real_message(self):
        lines = ["• 作業中", "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), try again at 9:36 AM.", "› "]
        self.assertTrue(lw.find_hit("codex", lines).startswith("■ You've hit"))

    def test_claude_variants(self):
        for s in ("You've hit your limit · resets 3pm", "  ⎿  5-hour limit reached ∙ resets 3pm", "API Error: Claude usage limit reached."):
            self.assertTrue(lw.find_hit("claude", [s]), s)

    def test_quotes_and_prose_do_not_match(self):
        for s in ("「You've hit your usage limit」と出る", "- You've hit your usage limit が出たら", "`You've hit your usage limit` を探す",
                  "Codex は You've hit your usage limit と表示する", "上限に達したら引き継ぐ"):
            self.assertIsNone(lw.find_hit("codex", [s]), s)

    def test_reset_time(self):
        self.assertEqual(lw.RESET.search("try again at 9:36 AM.").group(1).rstrip("."), "9:36 AM")
        self.assertEqual(lw.RESET.search("resets 3pm").group(1), "3pm")


class TargetTests(unittest.TestCase):
    def ev(self, agent, status, hours_ago=0):
        return {"agent": agent, "status": status, "detected_at": (datetime.now() - timedelta(hours=hours_ago)).isoformat()}

    def test_other_main_agent_first(self):
        self.assertEqual(lw.pick_target("claude", set()), "codex")
        self.assertEqual(lw.pick_target("codex", set()), "claude")

    def test_skips_limited_kinds_in_order(self):
        self.assertEqual(lw.pick_target("claude", {"codex"}), "hermes")
        self.assertEqual(lw.pick_target("claude", {"codex", "hermes"}), "agy")
        self.assertEqual(lw.pick_target("codex", {"claude", "hermes"}), "agy")

    def test_all_limited_falls_back_to_first_so_it_fails_visibly(self):
        self.assertEqual(lw.pick_target("claude", {"codex", "hermes", "agy"}), "codex")

    def test_limited_kinds_counts_pending_and_recent_handed_only(self):
        evs = [self.ev("claude", "handed", 1), self.ev("codex", "pending", 0), self.ev("hermes", "handed", 9),
               self.ev("agy", "cleared", 0), self.ev("opencode", "dismissed", 0)]
        self.assertEqual(lw.limited_kinds(evs), {"claude", "codex"})


class TranscriptTests(unittest.TestCase):
    def test_messages_claude_and_codex(self):
        with tempfile.TemporaryDirectory() as d:
            c, x = Path(d, "c.jsonl"), Path(d, "x.jsonl")
            c.write_text("\n".join(json.dumps(r) for r in [
                {"type": "user", "message": {"content": "最初の依頼"}},
                {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "x"}, {"type": "text", "text": "了解"}]}},
                {"type": "user", "message": {"content": "<system-reminder>注入</system-reminder>"}},
            ]), encoding="utf-8")
            x.write_text("\n".join(json.dumps(r) for r in [
                {"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "規則"}]}},
                {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "依頼"}]}},
                {"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "返答"}]}},
            ]), encoding="utf-8")
            self.assertEqual(lw.messages(str(c)), [("user", "最初の依頼"), ("assistant", "了解")])
            self.assertEqual(lw.messages(str(x)), [("user", "依頼"), ("assistant", "返答")])


if __name__ == "__main__":
    unittest.main()
