import json
from pathlib import Path
import subprocess
import socket
import tempfile
import time
import threading
import unittest
from unittest.mock import patch

import patrol


def agent(pane, project, status="done", cwd=""):
    return {"pane_id": pane, "terminal_id": "terminal-" + pane,
            "workspace_id": project, "tab_id": project + ":tab",
            "agent": "codex", "agent_status": status, "cwd": cwd,
            "state_change_seq": 5, "completion_seq": 5,
            "interactive_ready": True, "launch_pending": False}


class NativeConversationTests(unittest.TestCase):
    def test_known_session_filters_tools_and_meta(self):
        sid = "12345678-1234-1234-1234-123456789abc"
        row = {"agent": "claude", "agent_session": {"agent": "claude", "kind": "id", "value": sid}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); project = root / "project"; project.mkdir()
            events = [
                {"type": "user", "message": {"content": "テストを直して"}},
                {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
                {"type": "user", "message": {"content": [{"type": "tool_result", "content": "secret tool output"}]}},
                {"type": "user", "isMeta": True, "message": {"content": "injected reminder"}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "続けますか？"}]}},
            ]
            (project / f"{sid}.jsonl").write_text("\n".join(json.dumps(event) for event in events))
            text = patrol.claude_conversation(row, root)
            self.assertEqual(text, "[user]\nテストを直して\n\n[assistant]\n続けますか？")
            self.assertIsNone(patrol.claude_conversation({"agent": "claude"}, root))
            (root / "other").mkdir()
            (root / "other" / f"{sid}.jsonl").write_text("{}")
            self.assertIsNone(patrol.claude_conversation(row, root))


class FakeHerdr:
    def __init__(self, rows):
        self.rows = rows
        self.sent = []
        self.fail_send = False
        self.reservations = {}
        self.text = "ユーザー: 依頼したテストを直してください。\nAI: 残りの修正を続けますか？"

    def sessions(self):
        return list(self.rows)

    def snapshot(self, session):
        agents = self.rows[session]
        return {"agents": agents,
                "workspaces": [{"workspace_id": a["workspace_id"], "label": a["workspace_id"]} for a in agents],
                "tabs": [{"tab_id": a["tab_id"], "label": a["tab_id"]} for a in agents]}

    def screen(self, row):
        return self.text

    def watcher_reason(self, row):
        return self.reservations.get(row["terminal_id"], "")

    def call(self, session, *args, **kwargs):
        self.sent.append((session, args))
        if self.fail_send:
            raise subprocess.TimeoutExpired("fake-herdr", 15)
        for row in self.rows[session]:
            if row["pane_id"] == args[2]:
                row["agent_status"] = "working"
        return {"result": {"agent": {"agent_status": "working"}}}


def resume(screen, config):
    return {"action": "resume", "reason": "依頼済みの続き",
            "question": "残りの修正を続けますか？",
            "user_evidence": "依頼したテストを直してください。",
            "assistant_evidence": "残りの修正を続けますか？"}


class PatrolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / "attempts.json"
        self.config = json.loads(Path(patrol.__file__).with_name("patrol.json").read_text())
        self.journal = {}
        self.addCleanup(patch.stopall)
        patch.dict("os.environ", {"HERDR_SESSION": "default", "HERDR_PANE_ID": "caller"}).start()

    def run_patrol(self, client, apply=True, assess=resume, sessions=None):
        with patch("builtins.print"):
            return patrol.patrol(client, sessions or client.sessions(), self.config, self.journal,
                                 self.path, apply, time.monotonic(), assess)

    def test_progress_reports_hold_and_skip_without_submitting(self):
        rows = [agent("a", "atelier", cwd=str(self.root)), agent("b", "atelier", status="working", cwd=str(self.root))]
        client = FakeHerdr({"default": rows})
        updates = []
        def assess(screen, config):
            raise ValueError("invalid response")
        def progress(results, total):
            updates.append((len(results), total, [row.get("action") for row in results]))
        with patch("builtins.print"):
            result = patrol.patrol(client, client.sessions(), self.config, {}, self.path,
                                   True, time.monotonic(), assess, progress)
        self.assertEqual(updates, [(0, 2, []), (1, 2, ["hold"]), (2, 2, ["hold", "skip"])])
        self.assertEqual(result[0]["error_type"], "ValueError")
        self.assertEqual(client.sent, [])

    def test_expired_run_budget_does_not_classify_or_submit(self):
        client = FakeHerdr({"default": [agent("a", "atelier", cwd=str(self.root))]})
        self.config["_run_deadline"] = time.monotonic() - 1
        with patch("patrol.classify") as assess:
            result = self.run_patrol(client, assess=assess)
        assess.assert_not_called()
        self.assertEqual(result[0]["action"], "hold")
        self.assertEqual(client.sent, [])

    def test_preview_sorts_all_sessions_without_sending_or_claiming(self):
        client = FakeHerdr({"default": [agent("w1:p1", "side-project", cwd=str(self.root))],
                            "work": [agent("w1:p1", "my-main-project", cwd=str(self.root)),
                                     agent("w2:p1", "side-project", cwd=str(self.root))]})
        rows = self.run_patrol(client, apply=False)
        self.assertEqual([r["priority"] for r in rows], [100, 50, 50])
        self.assertEqual(rows[0]["session"], "work")
        self.assertEqual(client.sent, [])
        self.assertFalse(self.path.exists())

    def test_blocked_working_unknown_and_caller_never_get_classified(self):
        rows = [agent("p1", "project-a", "blocked"), agent("p2", "project-b", "working"),
                agent("p3", "atelier", "unknown"), agent("caller", "atelier")]
        client = FakeHerdr({"default": rows})
        def forbidden(*args):
            self.fail("ineligible agent was classified")
        result = self.run_patrol(client, assess=forbidden)
        self.assertTrue(all(r["action"] == "skip" for r in result))
        self.assertEqual(client.sent, [])

    def test_projects_and_automations_own_their_panes(self):
        project = agent("p1", "project-a", cwd=str(self.root))
        project["tokens"] = {"hp_project": "project-a"}
        automation = agent("p2", "project-b", cwd=str(self.root))
        automation["tab_id"] = "auto:nightly"
        client = FakeHerdr({"default": [project, automation]})
        def forbidden(*args):
            self.fail("plugin-owned pane was classified by patrol")
        rows = self.run_patrol(client, assess=forbidden)
        self.assertTrue(all(row["action"] == "skip" for row in rows))
        self.assertEqual(client.sent, [])

    def test_watcher_reserved_pane_is_not_classified_or_sent(self):
        client = FakeHerdr({"default": [agent("p1", "project-a", cwd=str(self.root))]})
        client.reservations["terminal-p1"] = "Watcher の再開予約"
        def forbidden(*args):
            self.fail("watcher-reserved pane was classified")
        self.assertEqual(self.run_patrol(client, assess=forbidden)[0]["action"], "skip")
        self.assertEqual(client.sent, [])

    def test_reservation_created_during_classification_cancels_send(self):
        client = FakeHerdr({"default": [agent("p1", "project-a", cwd=str(self.root))]})
        def reserve(screen, config):
            client.reservations["terminal-p1"] = "Watcher の再開予約"
            return resume(screen, config)
        self.assertEqual(self.run_patrol(client, assess=reserve)[0]["action"], "hold")
        self.assertEqual(client.sent, [])

    def test_read_only_watcher_socket_reserves_pending_jobs_and_workers(self):
        scope = patrol.hashlib.sha256(b"/herdr.sock").hexdigest()[:16]
        root = self.root / "sessions" / scope
        root.mkdir(parents=True)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(root / "control.sock"))
        listener.listen(1)
        listener.settimeout(3)
        self.addCleanup(listener.close)
        resources = {"continuations": {"c": {"state": "armed", "origin": {"terminal_id": "origin"}}},
                     "delegations": [{"state": "open", "origin": {"terminal_id": "parent"},
                                      "workers": [{"terminal_id": "worker"}]}],
                     "deliveries": [{"state": "queued", "origin": {"terminal_id": "queued"}},
                                    {"state": "unconfirmed", "origin": {"terminal_id": "uncertain"}},
                                    {"state": "delivered", "origin": {"terminal_id": "finished"}}]}
        received = []
        def serve():
            with listener.accept()[0] as stream:
                received.append(stream.recv(100))
                stream.sendall(json.dumps({"ok": True, "value": resources}).encode() + b"\n")
        thread = threading.Thread(target=serve)
        thread.start()
        try:
            self.assertEqual(patrol.watcher_reservations("/herdr.sock", self.root),
                             {"origin", "parent", "worker", "queued", "uncertain"})
        finally:
            thread.join(4)
        self.assertEqual(received, [b'"List"\n'])

    def test_watcher_respects_xdg_state_home(self):
        client = patrol.Herdr("/fake/herdr")
        client.session_sockets["default"] = "/herdr.sock"
        row = {"session": "default", "terminal_id": "origin"}
        with patch.dict("patrol.os.environ", {"XDG_STATE_HOME": str(self.root)}):
            with patch("patrol.watcher_reservations", return_value={"origin"}) as inspect:
                self.assertIn("Watcher", client.watcher_reason(row))
                inspect.assert_called_once_with("/herdr.sock", self.root / "herdr/plugins/joshka.watcher")

    def test_watcher_absent_is_clear_but_unreachable_journal_blocks(self):
        self.assertEqual(patrol.watcher_reservations("/herdr.sock", self.root), set())
        scope = patrol.hashlib.sha256(b"/herdr.sock").hexdigest()[:16]
        root = self.root / "sessions" / scope
        root.mkdir(parents=True)
        (root / "journal.jsonl").write_text("persisted pending job\n")
        client = patrol.Herdr("/fake/herdr")
        client.session_sockets["default"] = "/herdr.sock"
        original = patrol.watcher_reservations
        with patch("patrol.watcher_reservations", side_effect=lambda path, _: original(path, self.root)):
            self.assertIn("確認できません", client.watcher_reason({"session": "default", "terminal_id": "origin"}))

    def test_complete_and_personal_question_are_not_sent(self):
        client = FakeHerdr({"default": [agent("p1", "project-b", cwd=str(self.root))]})
        for action in ["hold", "complete"]:
            result = self.run_patrol(client, assess=lambda *args: {"action": action, "reason": "本人の判断または完了"})
            self.assertEqual(result[0]["action"], action)
        self.assertEqual(client.sent, [])

    def test_resume_claims_before_send_and_does_not_retry_same_stop(self):
        row = agent("p1", "project-a", cwd=str(self.root))
        client = FakeHerdr({"default": [row]})
        original = client.call
        def check_claim(*args, **kwargs):
            stored = json.loads(self.path.read_text())
            self.assertEqual(next(iter(stored.values()))["status"], "sending")
            return original(*args, **kwargs)
        client.call = check_claim
        self.assertEqual(self.run_patrol(client)[0]["action"], "sent")
        self.assertIn(patrol.MARKER, client.sent[0][1][3])
        row["agent_status"] = "idle"
        self.assertEqual(self.run_patrol(client)[0]["action"], "skip")
        self.assertEqual(len(client.sent), 1)

    def test_timeout_leaves_durable_claim_and_stops_remaining_sends(self):
        client = FakeHerdr({"default": [agent("p1", "project-a", cwd=str(self.root)),
                                        agent("p2", "project-b", cwd=str(self.root))]})
        client.fail_send = True
        self.assertEqual(self.run_patrol(client)[0]["action"], "uncertain")
        self.assertEqual(len(client.sent), 1)
        self.assertEqual(next(iter(json.loads(self.path.read_text()).values()))["status"], "uncertain")

    def test_changed_identity_is_not_prompted(self):
        client = FakeHerdr({"default": [agent("p1", "project-a", cwd=str(self.root))]})
        def swapped(screen, config):
            client.rows["default"][0]["terminal_id"] = "replacement"
            return resume(screen, config)
        self.assertEqual(self.run_patrol(client, assess=swapped)[0]["action"], "hold")
        self.assertEqual(client.sent, [])

    def test_changed_screen_is_not_prompted(self):
        client = FakeHerdr({"default": [agent("p1", "project-a", cwd=str(self.root))]})
        def changed(screen, config):
            client.text = "AI: 公開先を指定してください"
            return resume(screen, config)
        self.assertEqual(self.run_patrol(client, assess=changed)[0]["action"], "hold")
        self.assertEqual(client.sent, [])

    def test_other_sessions_count_toward_parallel_limit(self):
        self.config["max_parallel"] = 1
        client = FakeHerdr({"default": [agent("p1", "project-a", cwd=str(self.root))],
                            "other": [agent("p1", "project-b", "working", cwd=str(self.root))]})
        result = self.run_patrol(client, sessions=["default"])
        self.assertEqual(result[0]["action"], "hold")
        self.assertEqual(client.sent, [])

    def test_conflicts_include_git_root_and_nested_directories(self):
        repo = self.root / "repo"
        nested = repo / "src"
        nested.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
        target = agent("p1", "project-a", cwd=str(repo))
        active = agent("p2", "project-b", "working", cwd=str(nested))
        self.assertTrue(patrol.conflicts(target, [active]))
        self.assertTrue(patrol.conflicts(target, [agent("p3", "project-b", "unknown")]))
        self.assertFalse(patrol.conflicts(target, []))

    def test_common_atelier_ancestor_does_not_boost_unrelated_projects(self):
        row = dict(agent("p1", "unrelated", cwd="/nonexistent/atelier/unrelated"), workspace="unrelated", tab="misc")
        self.assertEqual(patrol.priority(row, self.config["priorities"]), 0)

    def test_evidence_must_exist_in_screen(self):
        verdict = resume("", self.config)
        self.assertEqual(patrol.validate_verdict(verdict, "different content")["action"], "hold")
        self.assertEqual(patrol.validate_verdict(verdict, FakeHerdr({}).text)["action"], "resume")
        with self.assertRaises(ValueError):
            patrol.validate_verdict({"action": "approve", "reason": "yes"}, "")

    def test_classifier_failure_becomes_hold(self):
        client = FakeHerdr({"default": [agent("p1", "project-a", cwd=str(self.root))]})
        def failed(*args):
            raise ValueError("malformed classifier output")
        self.assertEqual(self.run_patrol(client, assess=failed)[0]["action"], "hold")
        self.assertEqual(client.sent, [])

    def test_model_cannot_resume_a_choice_or_approval_question(self):
        for question in ["どちらを採用しますか？", "おすすめの案で続けてよいですか？",
                         "続けて削除してよいですか？", "Which option should I proceed with?",
                         "May I proceed with the recommended option?"]:
            screen = "ユーザー: 比較してください。\nAI: " + question
            verdict = {"action": "resume", "reason": "モデルの誤判定", "question": question,
                       "user_evidence": "比較してください。", "assistant_evidence": question}
            self.assertEqual(patrol.validate_verdict(verdict, screen)["action"], "hold")

    def test_model_cannot_invent_a_continuation_question(self):
        screen = "ユーザー: 比較してください。\nAI: どちらにしますか？"
        verdict = {"action": "resume", "reason": "モデルの誤判定", "question": "続けますか？",
                   "user_evidence": "比較してください。", "assistant_evidence": "どちらにしますか？"}
        self.assertEqual(patrol.validate_verdict(verdict, screen)["action"], "hold")

    def test_cli_handles_session_json_and_plain_text_read(self):
        client = patrol.Herdr("/fake/herdr")
        outputs = [json.dumps({"sessions": [{"name": "default", "running": True},
                                            {"name": "stopped", "running": False}]}),
                   "AI: 続きを進めますか？"]
        with patch("subprocess.run", side_effect=[subprocess.CompletedProcess([], 0, out, "") for out in outputs]) as run:
            self.assertEqual(client.sessions(), ["default"])
            self.assertEqual(client.screen({"session": "default", "pane_id": "w1:p1"}), outputs[1])
        self.assertEqual(run.call_args_list[1].args[0][:5], ["/fake/herdr", "--session", "default", "agent", "read"])

    def test_classifier_uses_router_and_preserves_jev_disagreement(self):
        verdict = dict(resume("", self.config), judge={"engine": "hermes", "profile": "default"})
        shadow = {"status": "ok", "mode": "shadow", "answers": {"route": {"choice": "hold"}}}
        with patch("patrol.router_verdict", return_value=verdict), patch("patrol.jev_shadow", return_value=shadow):
            result = patrol.classify(FakeHerdr({}).text, self.config)
        self.assertEqual(result["action"], "resume")
        self.assertEqual(result["judge"]["profile"], "default")
        self.assertFalse(result["jev"]["agrees_with_router"])

    def test_router_invalid_evidence_still_holds_when_jev_says_resume(self):
        verdict = dict(resume("", self.config), judge={"engine": "hermes", "profile": "default"})
        verdict["user_evidence"] = "fabricated user permission"
        shadow = {"status": "ok", "mode": "shadow", "answers": {"route": {"choice": "resume"}}}
        with patch("patrol.router_verdict", return_value=verdict), patch("patrol.jev_shadow", return_value=shadow):
            result = patrol.classify(FakeHerdr({}).text, self.config)
        self.assertEqual(result["action"], "hold")
        self.assertIn("jev", result)


if __name__ == "__main__":
    unittest.main()
