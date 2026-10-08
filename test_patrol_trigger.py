import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest

import patrol_trigger


class SummaryTests(unittest.TestCase):
    def test_exports_counts_without_conversation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "last-report.json").write_text(json.dumps({"results": [
                {"action": "sent", "question": "private conversation"},
                {"action": "hold", "error_type": "HTTPError"},
                {"action": "complete"}]}))
            result = patrol_trigger.summary(root)
            self.assertEqual(result["counts"]["sent"], 1)
            self.assertEqual(result["counts"]["failed"], 1)
            self.assertNotIn("private conversation", json.dumps(result))

    def test_dead_process_is_interrupted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "progress.json").write_text(json.dumps({"state": "running", "pid": 999999999, "counts": {}}))
            self.assertEqual(patrol_trigger.summary(root)["state"], "interrupted")


class TriggerTests(unittest.TestCase):
    def exchange(self, reply):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "control.sock"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(path))
                server.listen(1)
                received = []

                def respond():
                    stream, _ = server.accept()
                    with stream, stream.makefile("rb") as reader:
                        request = json.loads(reader.readline())
                        received.append(request)
                        stream.sendall((json.dumps(reply(request)) + "\n").encode())

                worker = threading.Thread(target=respond)
                worker.start()
                try:
                    response = patrol_trigger.control(path, "run-now")
                finally:
                    worker.join(2)
                return response, received

    def test_request_queues_only_the_patrol(self):
        response, requests = self.exchange(lambda r: {"id": r["id"], "ok": True, "result": {"runId": "trial"}})
        self.assertEqual(response["result"]["runId"], "trial")
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["method"], "run-now")
        self.assertEqual(requests[0]["params"], {"id": "herdr-patrol"})

    def test_worker_rejection_is_not_success(self):
        with self.assertRaisesRegex(RuntimeError, "overlap"):
            self.exchange(lambda r: {"id": r["id"], "ok": False, "error": "overlap"})

    def test_unmatched_response_is_not_success(self):
        with self.assertRaises(RuntimeError):
            self.exchange(lambda r: {"id": "other", "ok": True})

    def test_absent_worker_does_not_start_one(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                patrol_trigger.control(Path(directory) / "absent.sock", "run-now")
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
