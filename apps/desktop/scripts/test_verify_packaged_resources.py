"""Protocol/evidence regressions; stdlib only, no model or OpenCV required."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("packaged_resources", Path(__file__).with_name("verify-packaged-resources.py"))
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class PackagedResourceEvidenceTests(unittest.TestCase):
    def test_child_failure_preserves_stage_and_exception_without_raw_stderr(self):
        with tempfile.TemporaryDirectory(prefix="worker-evidence-") as temp:
            directory = Path(temp)
            (directory / "worker.py").write_text(
                "import sys\nsys.stderr.write('FileNotFoundError: private-fixture-marker\\n')\nsys.exit(1)\n",
                encoding="utf-8")
            progress = {}
            with self.assertRaisesRegex(AssertionError, "process exit 1"):
                SMOKE.worker(directory, "worker.py", {}, progress)
            self.assertEqual(progress["worker.py"], {
                "status": "failed", "stage": "worker-exit", "exitCode": 1, "exceptionType": "FileNotFoundError"})
            self.assertNotIn("private-fixture-marker", json.dumps(progress))

    def test_successful_protocol_still_requires_algorithm_assertions(self):
        with tempfile.TemporaryDirectory(prefix="worker-evidence-") as temp:
            directory = Path(temp)
            (directory / "worker.py").write_text('print(\'{"ok":true,"result":{"status":"tracked"}}\')\n', encoding="utf-8")
            progress = {}
            self.assertEqual(SMOKE.worker(directory, "worker.py", {}, progress), {"status": "tracked"})
            self.assertEqual(progress["worker.py"]["stage"], "algorithm-assertions")
            self.assertEqual(progress["worker.py"]["status"], "running")

    def test_protocol_rejection_is_distinct_from_process_failure(self):
        with tempfile.TemporaryDirectory(prefix="worker-evidence-") as temp:
            directory = Path(temp)
            (directory / "worker.py").write_text('print(\'{"ok":false,"error":{"code":"bad_request"}}\')\n', encoding="utf-8")
            progress = {}
            with self.assertRaisesRegex(AssertionError, "rejected synthetic request"):
                SMOKE.worker(directory, "worker.py", {}, progress)
            self.assertEqual(progress["worker.py"], {"status": "failed", "stage": "protocol", "exitCode": 0})


if __name__ == "__main__":
    unittest.main()
