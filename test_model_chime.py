import json
import os
from pathlib import Path
import pty
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).with_name("model-chime.sh")


class ModelChimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.calls = self.root / "calls"
        stub = self.root / "setsid"
        stub.write_text('#!/bin/bash\nprintf "%s\\n" "${@: -1}" >> "$CHIME_TEST_CALLS"\n')
        stub.chmod(0o700)
        self.env = {**os.environ, "HOME": str(self.root),
                    "PATH": f"{self.root}:{os.environ['PATH']}",
                    "CHIME_TEST_CALLS": str(self.calls)}
        self.env.pop("HERMES_INTERACTIVE", None)

    def run_chime(self, agent, mode=None, payload=None, interactive=False, terminal=False):
        env = dict(self.env)
        if interactive:
            env["HERMES_INTERACTIVE"] = "1"
        command = ["bash", str(SCRIPT), agent, *([mode] if mode else [])]
        if terminal:
            # The hook's own stdio is piped even when its Hermes parent uses a TTY.
            master, slave = pty.openpty()
            runner = ("import subprocess,sys; "
                      "r=subprocess.run(sys.argv[2:],input=sys.argv[1],text=True,capture_output=True); "
                      "sys.exit(r.returncode)")
            try:
                subprocess.run([sys.executable, "-c", runner, json.dumps(payload or {}), *command],
                               stdin=slave, stdout=slave, stderr=slave, env=env,
                               check=True, timeout=3)
            finally:
                os.close(master)
                os.close(slave)
            return
        subprocess.run(command,
                       input=json.dumps(payload or {}), text=True, env=env,
                       capture_output=True, check=True, timeout=3)

    def assert_calls(self, tiers):
        deadline = time.monotonic() + .2
        while time.monotonic() < deadline:
            actual = self.calls.read_text().splitlines() if self.calls.exists() else []
            if len(actual) >= len(tiers) and tiers:
                break
            time.sleep(.01)
        self.assertEqual([line.rsplit(" ", 1)[-1] for line in actual], tiers)

    def test_codex_model_tiers(self):
        for model, tier in [("gpt-6.1-sol", "mid"), ("gpt-6-sol", "mid"),
                            ("gpt-6-sol-latest", "mid"), ("gpt-6-astra", "high"),
                            ("gpt-6-astra-latest", "high"), ("gpt-6-luna", "low")]:
            with self.subTest(model=model):
                self.calls.unlink(missing_ok=True)
                self.run_chime("codex", model)
                self.assert_calls([tier])

    def test_other_model_tiers(self):
        for model, tier in [("claude-opus", "high"), ("claude-sonnet", "mid"),
                            ("claude-haiku", "low"), ("gemini-pro", "high"),
                            ("gemini-flash", "mid"), ("gemini-flash-low", "low")]:
            with self.subTest(model=model):
                self.calls.unlink(missing_ok=True)
                self.run_chime("test", model)
                self.assert_calls([tier])

    def test_background_hermes_session_does_not_play(self):
        self.run_chime("hermes", payload={"session_id": "patrol-judge",
                       "extra": {"platform": "cli", "model": "gemini-flash"}})
        self.assert_calls([])

    def test_interactive_hermes_session_plays(self):
        self.run_chime("hermes", interactive=True, terminal=True, payload={"session_id": "interactive",
                       "extra": {"platform": "cli", "model": "gemini-flash"}})
        self.assert_calls(["mid"])

    def test_quiet_hermes_with_interactive_flag_does_not_play(self):
        self.run_chime("hermes", interactive=True, payload={"session_id": "quiet-patrol",
                       "extra": {"platform": "cli", "model": "gemini-flash"}})
        self.assert_calls([])

    def test_cron_and_gateway_do_not_play(self):
        for platform in ["cron", "telegram"]:
            self.run_chime("hermes", interactive=True, terminal=True,
                           payload={"extra": {"platform": platform, "model": "gemini-flash"}})
        self.assert_calls([])

    def test_startup_is_silent_and_first_submit_plays_once(self):
        payload = {"session_id": "new-conversation", "model": "gpt-6.1-sol"}
        self.run_chime("codex", "arm", payload)
        self.assert_calls([])
        self.run_chime("codex", "fire", payload)
        self.run_chime("codex", "fire", payload)
        self.assert_calls(["mid"])

    def test_resumed_session_without_arm_does_not_play(self):
        self.run_chime("codex", "fire", {"session_id": "resumed", "model": "gpt-6-astra"})
        self.assert_calls([])


if __name__ == "__main__":
    unittest.main()
