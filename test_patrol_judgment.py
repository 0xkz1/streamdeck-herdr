import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import patrol_judgment


class JudgmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / "hermes"
        self.config = {"hermes_bin": str(self.binary), "hermes_profile": "chosen-router",
                       "judgment_timeout_seconds": 2,
                       "jev": {"mode": "shadow", "model": "jev-test", "timeout_seconds": 1}}

    def fake_router(self, body):
        self.binary.write_text("#!/usr/bin/python3\n" + body)
        self.binary.chmod(0o700)

    def test_profile_selected_without_model_override_or_worker_tools(self):
        capture = self.root / "arguments.json"
        self.fake_router("import json,sys,os\n"
                         + f"open({str(capture)!r},'w').write(json.dumps({{'args':sys.argv,'kanban':os.getenv('HERMES_KANBAN_TASK'),'interactive':os.getenv('HERMES_INTERACTIVE')}}))\n"
                         + "print('session_id: sample')\nprint('{\"action\":\"hold\",\"reason\":\"missing context\"}')\n")
        with patch.dict(os.environ, {"HERMES_KANBAN_TASK": "unrelated-worker", "HERMES_INTERACTIVE": "1"}):
            result = patrol_judgment.router_verdict("conversation", self.config, "instructions")
        data = json.loads(capture.read_text()); args = data["args"]
        self.assertEqual(args[args.index("--profile") + 1], self.config["hermes_profile"])
        self.assertEqual(args[args.index("--toolsets") + 1], "none")
        self.assertEqual(args[args.index("--source") + 1], "tool")
        self.assertNotIn("--model", args)
        self.assertNotIn("--provider", args)
        self.assertIsNone(data["kanban"])
        self.assertIsNone(data["interactive"])
        self.assertEqual(result["judge"]["profile"], self.config["hermes_profile"])

    def test_multiple_verdicts_are_not_guessed(self):
        self.fake_router("print('{\"action\":\"resume\"} {\"action\":\"hold\"}')\n")
        with self.assertRaises(ValueError):
            patrol_judgment.router_verdict("conversation", self.config, "instructions")

    def test_router_error_does_not_expose_credentials(self):
        self.fake_router("import sys\nprint('private-provider-key',file=sys.stderr)\nsys.exit(1)\n")
        with self.assertRaises(RuntimeError) as caught:
            patrol_judgment.router_verdict("conversation", self.config, "instructions")
        self.assertNotIn("private-provider-key", str(caught.exception))

    def test_timeout_stops_the_judgment_and_its_child(self):
        child_pid = self.root / "child.pid"
        self.fake_router("import subprocess,time\n"
                         + "child=subprocess.Popen(['/usr/bin/python3','-c','import time;time.sleep(20)'])\n"
                         + f"open({str(child_pid)!r},'w').write(str(child.pid))\n"
                         + "time.sleep(20)\n")
        self.config["judgment_timeout_seconds"] = .3
        with self.assertRaises(subprocess.TimeoutExpired):
            patrol_judgment.router_verdict("conversation", self.config, "instructions")
        status = Path(f"/proc/{child_pid.read_text()}/stat")
        try:
            child_state = status.read_text().split()[2]
        except FileNotFoundError:
            child_state = None
        self.assertIn(child_state, (None, "Z"))

    def test_jev_off_never_contacts_service(self):
        self.config["jev"]["mode"] = "off"
        with patch("urllib.request.urlopen") as call:
            self.assertIsNone(patrol_judgment.jev_shadow("conversation", self.config))
        call.assert_not_called()

    def test_jev_keeps_distributions_and_omits_unexpected_content(self):
        response = {"model": "jev-test", "answers": {
            "route": {"choice": "hold", "confidence": .5, "probabilities": {"hold": .7, "resume": .3},
                      "unexpected_text": "private content"},
            "needs_new_decision": {"noul": .8}, "authorized_work_remains": {"noul": .2}}}
        with patch.dict(os.environ, {"TYPESAFE_API_KEY": "fake"}), patch(
                "urllib.request.urlopen", return_value=io.BytesIO(json.dumps(response).encode())):
            result = patrol_judgment.jev_shadow("conversation", self.config)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["answers"]["route"]["probabilities"]["hold"], .7)
        self.assertNotIn("private content", json.dumps(result))

    def test_jev_error_and_malformed_payload_are_shadow_failures(self):
        with patch.dict(os.environ, {"TYPESAFE_API_KEY": "fake"}), patch(
                "urllib.request.urlopen", side_effect=urllib.error.HTTPError(
                    "https://api.typesafe.ai", 401, "private-provider-key", {}, None)):
            result = patrol_judgment.jev_shadow("conversation", self.config)
        self.assertEqual(result["status"], "error")
        self.assertNotIn("private-provider-key", json.dumps(result))
        with patch.dict(os.environ, {"TYPESAFE_API_KEY": "fake"}), patch(
                "urllib.request.urlopen", return_value=io.BytesIO(b'{"answers":null}')):
            result = patrol_judgment.jev_shadow("conversation", self.config)
        self.assertEqual(result["status"], "error")


if __name__ == "__main__":
    unittest.main()
