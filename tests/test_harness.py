# ChatGPT 브라우저 검증 하네스의 안전 경계와 상태 전이를 검증한다.
from __future__ import annotations

import json
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

import harness  # noqa: E402


class HarnessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.run_dir = self.root / "run"
        harness.prepare(self.run_dir, PROJECT_ROOT / "fixtures" / "broken.txt")
        harness.record_session(self.run_dir, "https://chatgpt.com/c/test-conversation")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_result(self, content: str, *, member: str = harness.EXPECTED_MEMBER) -> Path:
        result = self.root / f"result-{uuid_suffix(content)}.zip"
        with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(member, content)
        return result

    def test_prepare_creates_context_contract_and_state(self) -> None:
        state = json.loads((self.run_dir / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["status"], "submitted")
        self.assertTrue(state["operation_id"])
        with zipfile.ZipFile(self.run_dir / "context.zip") as archive:
            self.assertEqual(sorted(archive.namelist()), ["CONTRACT.json", "workspace/input.txt"])

    def test_first_failure_creates_feedback_zip(self) -> None:
        report, exit_code = harness.verify(self.run_dir, self.write_result("BROKEN: first transport canary\n"))
        self.assertEqual(exit_code, 2)
        self.assertEqual(report["status"], "fail")
        feedback_zip = self.run_dir / "feedback" / "feedback-001.zip"
        self.assertTrue(feedback_zip.is_file())
        with zipfile.ZipFile(feedback_zip) as archive:
            self.assertEqual(sorted(archive.namelist()), ["feedback.md", "verification.json"])

    def test_corrected_result_passes(self) -> None:
        harness.verify(self.run_dir, self.write_result("BROKEN: first transport canary\n"))
        report, exit_code = harness.verify(self.run_dir, self.write_result(harness.EXPECTED_TEXT))
        self.assertEqual(exit_code, 0)
        self.assertEqual(report["status"], "pass")
        state = json.loads((self.run_dir / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["status"], "verified")

    def test_repeated_failure_stops_loop(self) -> None:
        harness.verify(self.run_dir, self.write_result("same failure\n"))
        harness.verify(self.run_dir, self.write_result("same failure\n"))
        state = json.loads((self.run_dir / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["status"], "stopped")
        self.assertEqual(state["stop_reason"], "repeated_failure")

    def test_zip_slip_is_rejected(self) -> None:
        report, exit_code = harness.verify(self.run_dir, self.write_result("escape", member="../escape.txt"))
        self.assertEqual(exit_code, 2)
        self.assertIn("ZIP 경로 탈출", "\n".join(report["errors"]))
        self.assertFalse((self.root / "escape.txt").exists())

    def test_symlink_is_rejected(self) -> None:
        result = self.root / "symlink.zip"
        info = zipfile.ZipInfo(harness.EXPECTED_MEMBER)
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(result, "w") as archive:
            archive.writestr(info, "target")
        report, exit_code = harness.verify(self.run_dir, result)
        self.assertEqual(exit_code, 2)
        self.assertIn("심볼릭 링크", "\n".join(report["errors"]))

    def test_conversation_url_cannot_change(self) -> None:
        with self.assertRaises(harness.ContractError):
            harness.record_session(self.run_dir, "https://chatgpt.com/c/other")

    def test_next_action_and_submission_keys_are_idempotent(self) -> None:
        fresh_run = self.root / "fresh-run"
        harness.prepare(fresh_run, PROJECT_ROOT / "fixtures" / "broken.txt")
        initial = harness.next_action(fresh_run)
        self.assertEqual(initial["action"], "submit_initial")
        self.assertEqual(initial["submission_key"].split(":")[-2:], ["initial", "0"])
        harness.record_session(fresh_run, "https://chatgpt.com/c/idempotent")
        harness.record_session(fresh_run, "https://chatgpt.com/c/idempotent")
        state = json.loads((fresh_run / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(len(state["submissions"]), 1)
        self.assertEqual(harness.next_action(fresh_run)["action"], "await_download")

    def test_feedback_action_stays_in_same_conversation(self) -> None:
        harness.verify(self.run_dir, self.write_result("wrong\n"))
        action = harness.next_action(self.run_dir)
        self.assertEqual(action["action"], "submit_feedback")
        self.assertEqual(action["conversation_url"], "https://chatgpt.com/c/test-conversation")
        harness.record_submission(self.run_dir, action["conversation_url"], "feedback")
        self.assertEqual(harness.next_action(self.run_dir)["action"], "await_download")

    def test_command_verifier_uses_local_configured_command(self) -> None:
        spec_path = self.root / "command-spec.json"
        spec = {
            "schema_version": 1,
            "name": "command-test",
            "prompt": "operation_id: {operation_id}",
            "context_files": [],
            "result": {
                "filename": "result.zip",
                "required_members": [harness.EXPECTED_MEMBER],
                "allowed_members": [harness.EXPECTED_MEMBER],
            },
            "verifier": {
                "kind": "command",
                "argv": [sys.executable, str(PROJECT_ROOT / "verifiers" / "text_canary.py"), "{extracted_dir}"],
                "cwd": str(PROJECT_ROOT),
                "timeout_seconds": 30,
            },
            "max_attempts": 2,
        }
        spec_path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
        command_run = self.root / "command-run"
        harness.prepare(command_run, PROJECT_ROOT / "fixtures" / "broken.txt", spec_path)
        harness.record_session(command_run, "https://chatgpt.com/c/command-test")
        report, exit_code = harness.verify(command_run, self.write_result(harness.EXPECTED_TEXT))
        self.assertEqual(exit_code, 0)
        self.assertEqual(report["verifier"]["exit_code"], 0)
        self.assertEqual(report["verifier"]["stdout"], "verified\n")

    def test_different_command_failures_do_not_trigger_repeated_stop(self) -> None:
        command_run = self.root / "different-failures"
        harness.prepare(
            command_run,
            PROJECT_ROOT / "fixtures" / "broken.txt",
            PROJECT_ROOT / "specs" / "command-canary.json",
        )
        harness.record_session(command_run, "https://chatgpt.com/c/different-failures")
        first, _ = harness.verify(command_run, self.write_result("first\n"))
        second, _ = harness.verify(command_run, self.write_result("second\n"))
        self.assertNotEqual(first["failure_fingerprint"], second["failure_fingerprint"])
        state = json.loads((command_run / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["status"], "feedback_ready")

    def test_repeated_command_failure_stops_loop(self) -> None:
        command_run = self.root / "repeated-command-failure"
        harness.prepare(
            command_run,
            PROJECT_ROOT / "fixtures" / "broken.txt",
            PROJECT_ROOT / "specs" / "command-canary.json",
        )
        harness.record_session(command_run, "https://chatgpt.com/c/repeated-command-failure")
        first, _ = harness.verify(command_run, self.write_result("same command failure\n"))
        second, _ = harness.verify(command_run, self.write_result("same command failure\n"))
        self.assertEqual(first["failure_fingerprint"], second["failure_fingerprint"])
        state = json.loads((command_run / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["status"], "stopped")
        self.assertEqual(state["stop_reason"], "repeated_failure")

    def test_invalid_spec_does_not_leave_run_directory(self) -> None:
        invalid_spec = self.root / "invalid-spec.json"
        invalid_spec.write_text('{"schema_version": 1}', encoding="utf-8")
        invalid_run = self.root / "invalid-run"
        with self.assertRaises(harness.ContractError):
            harness.prepare(invalid_run, PROJECT_ROOT / "fixtures" / "broken.txt", invalid_spec)
        self.assertFalse(invalid_run.exists())


def uuid_suffix(value: str) -> str:
    return str(abs(hash(value)))


if __name__ == "__main__":
    unittest.main()
