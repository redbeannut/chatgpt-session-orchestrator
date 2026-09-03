from pathlib import Path
import tempfile
import unittest

from verifiers.markdown_research import main


class MarkdownResearchVerifierTests(unittest.TestCase):
    def test_accepts_cited_report(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "report.md").write_text("근거 [공식 문서](https://example.com/doc)", encoding="utf-8")
            (root / "sources.md").write_text("- [공식 문서](https://example.com/doc)", encoding="utf-8")
            self.assertEqual(main(str(root)), 0)

    def test_rejects_uncited_report(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "report.md").write_text("근거 없음", encoding="utf-8")
            (root / "sources.md").write_text("- [문서](https://example.com/doc)", encoding="utf-8")
            self.assertEqual(main(str(root)), 2)


if __name__ == "__main__":
    unittest.main()
