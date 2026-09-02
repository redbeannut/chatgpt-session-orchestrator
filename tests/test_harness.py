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


def uuid_suffix(value: str) -> str:
    return str(abs(hash(value)))


if __name__ == "__main__":
    unittest.main()

