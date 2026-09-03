"""Research ZIP의 Markdown 산출물과 인용 링크 구조만 로컬에서 검증한다."""

from pathlib import Path
import re
import sys


LINK = re.compile(r"\[[^\]]+\]\((https?://[^\s)]+)\)")


def main(extracted_dir: str) -> int:
    root = Path(extracted_dir)
    report_path = root / "report.md"
    sources_path = root / "sources.md"
    errors = []
    for target in (report_path, sources_path):
        if not target.is_file():
            errors.append(f"필수 파일이 없습니다: {target.name}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 2

    report = report_path.read_text(encoding="utf-8").strip()
    sources = sources_path.read_text(encoding="utf-8").strip()
    report_links = set(LINK.findall(report))
    source_links = set(LINK.findall(sources))
    if not report:
        errors.append("report.md가 비어 있습니다.")
    if not source_links:
        errors.append("sources.md에 Markdown 형식의 HTTP(S) 출처 링크가 없습니다.")
    if not report_links:
        errors.append("report.md 본문에 Markdown 인용 링크가 없습니다.")
    missing = sorted(report_links - source_links)
    if missing:
        errors.append("report.md 인용 중 sources.md에 없는 URL: " + ", ".join(missing))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 2
    print(f"Markdown 구조 검증 통과: report links={len(report_links)}, sources={len(source_links)}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: markdown_research.py <extracted_dir>", file=sys.stderr)
        raise SystemExit(1)
    raise SystemExit(main(sys.argv[1]))
