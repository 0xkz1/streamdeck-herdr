"""Run with: python3 -B streamdeck-herdr/test_handoff_retry.py -v"""

import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    "handoff", Path(__file__).with_name("handoff.py")
)
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


class PromptRetryTests(unittest.TestCase):
    def run_handoff(self, delivered_on, modal=False, error_after=None):
        clock = 0
        prompts = []
        renames = []
        memo_name = []

        def sleep(seconds):
            nonlocal clock
            clock += seconds

        def fake_screen(target):
            # 届いたプロンプトの本文(メモのファイル名を含む)が画面に出る。届く前は、ロゴだけ
            if modal:
                return "SessionStart hooks\n1 hook needs review before it can run.\nspace/enter toggle · esc back"
            shown = prompts[delivered_on - 1] if delivered_on and len(prompts) >= delivered_on else ""
            return "OpenAI Codex\n" + shown + ("\n" + error_after if error_after and shown else "")

        def fake_herdr(*args, **kwargs):
            if args == ("agent", "get", "source"):
                return {"result": {"agent": {
                    "cwd": "/fake/project", "workspace_id": "workspace",
                    "agent": "claude", "tab_id": "source-tab",
                    "agent_status": "done",
                }}}
            if args == ("tab", "get", "source-tab"):
                return {"result": {"tab": {"label": "claude"}}}
            if args[:3] == ("agent", "prompt", "source"):
                # Simulate the source agent writing its requested memo.
                memo = args[3].split("ファイルに書いてください: ", 1)[1].splitlines()[0]
                Path(memo).write_text("# Test handoff\n", encoding="utf-8")
                memo_name.append(Path(memo).name)
                return {"result": {}}
            if args[:3] == ("agent", "wait", "source"):
                return {"result": {}}
            if args == ("tab", "create", "--workspace", "workspace",
                        "--cwd", "/fake/project", "--label", "→codex"):
                return {"result": {
                    "root_pane": {"pane_id": "destination"},
                    "tab": {"tab_id": "destination-tab"},
                }}
            if args[:2] == ("agent", "start"):
                return {"result": {}}
            if args[:2] == ("tab", "rename"):
                renames.append(args[2:])
                return {"result": {}}
            if args == ("tab", "focus", "destination-tab"):
                return {"result": {}}
            if args == ("agent", "get", "destination"):
                return {"result": {"agent": {"agent_status": "idle"}}}
            if args[:3] == ("agent", "prompt", "destination"):
                prompts.append(args[3])
                return {"result": {}}
            raise AssertionError(f"Unexpected herdr call: {args!r} {kwargs!r}")

        output = io.StringIO()
        fake_time = Mock(time=lambda: clock, sleep=sleep)
        with tempfile.TemporaryDirectory() as out, \
                patch.object(handoff, "OUT", out), \
                patch.object(handoff, "herdr", side_effect=fake_herdr), \
                patch.object(handoff, "pane_screen", side_effect=fake_screen), \
                patch.object(handoff, "time", fake_time), \
                patch.object(handoff.sys, "argv", ["handoff.py", "source", "codex"]), \
                patch.object(handoff.subprocess, "run",
                             side_effect=AssertionError("Real subprocess forbidden")), \
                contextlib.redirect_stdout(output):
            if modal or error_after:
                with self.assertRaises(SystemExit):
                    handoff.main()
                return prompts, output.getvalue(), renames
            self.assertIsNone(handoff.main())

        self.assertTrue(prompts)
        self.assertTrue(all(text == prompts[0] for text in prompts))
        self.assertIn("done: new tab destination-tab pane destination", output.getvalue())
        return len(prompts), output.getvalue(), clock

    def test_first_prompt_delivered_without_retry(self):
        count, logs, elapsed = self.run_handoff(delivered_on=1)
        self.assertEqual(count, 1)
        self.assertEqual(elapsed, handoff.ERROR_CHECK_WAIT)
        self.assertNotIn("再送します", logs)
        self.assertNotIn("WARNING", logs)

    def test_second_prompt_delivered_after_one_retry(self):
        count, logs, elapsed = self.run_handoff(delivered_on=2)
        self.assertEqual(count, 2)
        self.assertEqual(elapsed, handoff.PROMPT_WAIT + handoff.ERROR_CHECK_WAIT)
        self.assertEqual(logs.count("再送します"), 1)
        self.assertNotIn("WARNING", logs)

    def test_three_undelivered_prompts_warn_and_return_normally(self):
        count, logs, elapsed = self.run_handoff(delivered_on=None)
        self.assertEqual(count, 3)
        self.assertEqual(elapsed, 3 * handoff.PROMPT_WAIT)
        self.assertEqual(logs.count("再送します"), 2)
        self.assertEqual(logs.count("WARNING:"), 1)
        self.assertIn("プロンプトが届いたか確認できなかった", logs)

    def test_modal_screen_blocks_prompt_and_marks_tab_failed(self):
        prompts, logs, renames = self.run_handoff(delivered_on=None, modal=True)
        self.assertEqual(prompts, [])  # 確認画面には、1回も送らない(再送も)
        self.assertEqual(renames, [("destination-tab", "✗codex")])
        self.assertIn("FAILED", logs)

    def test_error_in_first_response_marks_tab_failed(self):
        prompts, logs, renames = self.run_handoff(delivered_on=1, error_after="Individual quota reached. Please upgrade")
        self.assertEqual(len(prompts), 1)
        self.assertEqual(renames, [("destination-tab", "✗codex")])
        self.assertIn("FAILED", logs)


class FromLimitTests(unittest.TestCase):
    def test_limit_stopped_source_gets_no_prompt_and_memo_comes_from_digest(self):
        prompts, calls, memos = [], [], []

        def fake_herdr(*args, **kwargs):
            calls.append(args)
            if args == ("agent", "get", "source"):
                return {"result": {"agent": {"cwd": "/fake/project", "workspace_id": "workspace", "agent": "claude",
                                              "tab_id": "source-tab", "agent_session": {"value": "sess-1"}}}}
            if args == ("tab", "get", "source-tab"):
                return {"result": {"tab": {"label": "claude"}}}
            if args[:2] == ("tab", "create"):
                return {"result": {"root_pane": {"pane_id": "destination"}, "tab": {"tab_id": "destination-tab"}}}
            if args[:2] in (("agent", "start"), ("tab", "focus")):
                return {"result": {}}
            if args == ("agent", "get", "destination"):
                return {"result": {"agent": {"agent_status": "idle"}}}
            if args[:3] == ("agent", "prompt", "destination"):
                prompts.append(args[3])
                return {"result": {}}
            raise AssertionError(f"Unexpected herdr call: {args!r}")

        def fake_screen(target):
            return "OpenAI Codex\n" + (prompts[-1] if prompts else "")

        digest_calls = []
        fake_lw = Mock(digest=lambda *a: digest_calls.append(a) or "# 直近のユーザー指示\n1. 続けて", tail_lines=lambda pane: ["■ limit"])
        clock = 0
        fake_time = Mock(time=lambda: clock, sleep=lambda s: None)
        with tempfile.TemporaryDirectory() as out, \
                patch.object(handoff, "OUT", out), \
                patch.object(handoff, "herdr", side_effect=fake_herdr), \
                patch.object(handoff, "pane_screen", side_effect=fake_screen), \
                patch.object(handoff, "time", fake_time), \
                patch.dict("sys.modules", {"limit_watch": fake_lw}), \
                patch.object(handoff.sys, "argv", ["handoff.py", "--from-limit", "source", "codex"]), \
                patch.object(handoff.subprocess, "run", side_effect=AssertionError("Real subprocess forbidden")), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertIsNone(handoff.main())
            memos = [p.read_text(encoding="utf-8") for p in Path(out).glob("*.md") if not p.is_symlink()]

        self.assertFalse([c for c in calls if c[:3] in (("agent", "prompt", "source"), ("agent", "wait", "source"))])
        self.assertEqual(digest_calls, [("claude", "sess-1", "/fake/project", "■ limit")])
        self.assertEqual(len(memos), 1)
        self.assertIn("使用上限で止まった", memos[0])
        self.assertIn("1. 続けて", memos[0])
        self.assertEqual(len(prompts), 1)


if __name__ == "__main__":
    unittest.main()
