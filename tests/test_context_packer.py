# Context packer의 미리보기·비밀 차단·첨부 계약을 검증한다.
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from src.context_packer import build_pack


class ContextPackerTests(unittest.TestCase):
    def make_config(self, root: Path, **updates) -> Path:
        config = {
            "schema_version": 1,
            "root": str(root),
            "objective": "설계 허점을 찾는다.",
            "question": "이 설계의 가장 큰 허점은 무엇인가?",
            "required_output": "근거와 수정안을 Markdown으로 작성한다.",
            "include": ["**/*"],
        }
        config.update(updates)
        target = root.parent / "context.json"
        target.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        return target

    def test_builds_numbered_briefing_and_attachment_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "repo"
            root.mkdir()
            (root / "app.py").write_text("print('hello')\n", encoding="utf-8")
            (root / "screen.png").write_bytes(b"\x89PNG\r\n\x1a\n")
            (root / "archive.zip").write_bytes(b"PK\x03\x04.env")
            (root / "credentials.json").write_text('{"token":"real-secret-value-123456789"}', encoding="utf-8")
            output = base / "plan" / "briefing.md"

            markdown, report = build_pack(
                self.make_config(root, allow_binary_attachments=["screen.png"]), output
            )

            self.assertIn("0001 | print('hello')", markdown)
            self.assertNotIn("real-secret-value", markdown)
            self.assertEqual(report["blocked_or_skipped"], 2)
            self.assertEqual(report["context_files"][1]["member"], "evidence/screen.png")
            self.assertEqual(len(report["context_files"]), 2)
            self.assertTrue(any(
                item["path"] == "archive.zip" and item["status"] == "blocked"
                for item in report["files"]
            ))
            self.assertTrue(output.is_file())
            self.assertTrue(output.with_suffix(".context.json").is_file())

    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "repo"
            root.mkdir()
            (root / "README.md").write_text("hello", encoding="utf-8")
            output = base / "briefing.md"

            _, report = build_pack(self.make_config(root), output, dry_run=True)

            self.assertTrue(report["dry_run"])
            self.assertFalse(output.exists())
            self.assertFalse(output.with_suffix(".context.json").exists())

    def test_git_diff_obeys_exclude_patterns(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "repo"
            root.mkdir()
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
            subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.com"], check=True)
            (root / "public.txt").write_text("public-old\n", encoding="utf-8")
            (root / "private").mkdir()
            (root / "private" / "medical.txt").write_text("private-old\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            subprocess.run(["git", "-C", str(root), "commit", "-qm", "initial"], check=True)
            (root / "public.txt").write_text("public-new\n", encoding="utf-8")
            (root / "private" / "medical.txt").write_text("medical-record-private\n", encoding="utf-8")
            config = self.make_config(
                root, include=["**/*"], exclude=["private/**"], include_git_diff=True
            )

            markdown, report = build_pack(config, base / "briefing.md")

            self.assertIn("## Git diff", markdown)
            self.assertIn("public-new", markdown)
            self.assertNotIn("medical-record-private", markdown)
            self.assertTrue(any(
                item["path"] == "<git-diff>" and item["status"] == "inlined"
                for item in report["files"]
            ))

    def test_rejects_secret_in_briefing_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "repo"
            root.mkdir()
            config = self.make_config(
                root, confirmed_facts=["client_secret=abcdefghijklmnopqrstuvwxyz123456"]
            )

            with self.assertRaisesRegex(ValueError, "briefing 필드"):
                build_pack(config, base / "briefing.md")


if __name__ == "__main__":
    unittest.main()
