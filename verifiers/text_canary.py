# 범용 명령형 검증기 연결을 확인하는 로컬 전용 카나리다.
from __future__ import annotations

import sys
from pathlib import Path


EXPECTED = "PASS: browser loop verified\n"


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: text_canary.py EXTRACTED_DIR", file=sys.stderr)
        return 2
    target = Path(sys.argv[1]) / "solution" / "input.txt"
    if not target.is_file():
        print(f"missing: {target}", file=sys.stderr)
        return 2
    observed = target.read_text(encoding="utf-8")
    if observed != EXPECTED:
        print(f"content mismatch: {observed!r}", file=sys.stderr)
        return 2
    print("verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
