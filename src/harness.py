# ChatGPT 브라우저 왕복과 로컬 검증 상태를 관리하는 최소 PoC 하네스다.
from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


EXPECTED_TEXT = "PASS: browser loop verified\n"
EXPECTED_MEMBER = "solution/input.txt"
MAX_ATTEMPTS = 3
MAX_FILES = 100
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 20 * 1024 * 1024


class ContractError(RuntimeError):
    """입출력 계약 또는 안전 경계 위반을 나타낸다."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> dict:
    if not path.is_file():
        raise ContractError(f"필수 상태 파일이 없습니다: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def validate_member(info: zipfile.ZipInfo) -> PurePosixPath:
    raw_name = info.filename.replace("\\", "/")
    if not raw_name or "\x00" in raw_name:
        raise ContractError("ZIP에 비어 있거나 NUL을 포함한 경로가 있습니다.")
    member = PurePosixPath(raw_name)
    if member.is_absolute() or ".." in member.parts:
        raise ContractError(f"ZIP 경로 탈출을 거부했습니다: {raw_name}")
    if member.parts and ":" in member.parts[0]:
        raise ContractError(f"ZIP 드라이브 경로를 거부했습니다: {raw_name}")
    file_type = (info.external_attr >> 16) & 0o170000
    if file_type == stat.S_IFLNK:
        raise ContractError(f"ZIP 심볼릭 링크를 거부했습니다: {raw_name}")
    if info.file_size > MAX_FILE_BYTES:
        raise ContractError(f"ZIP 단일 파일 크기 제한을 초과했습니다: {raw_name}")
    return member


def safe_extract(zip_path: Path, destination: Path) -> list[str]:
    if not zip_path.is_file():
        raise ContractError(f"결과 ZIP이 없습니다: {zip_path}")
    if destination.exists():
        raise ContractError(f"검증 대상 폴더가 이미 존재합니다: {destination}")
    destination.mkdir(parents=True)
    extracted: list[str] = []
    total_bytes = 0
    with zipfile.ZipFile(zip_path) as archive:
        infos = archive.infolist()
        file_infos = [info for info in infos if not info.is_dir()]
        if len(file_infos) > MAX_FILES:
            raise ContractError("ZIP 파일 수 제한을 초과했습니다.")
        for info in infos:
            member = validate_member(info)
            total_bytes += info.file_size
            if total_bytes > MAX_TOTAL_BYTES:
                raise ContractError("ZIP 전체 압축 해제 크기 제한을 초과했습니다.")
            target = destination.joinpath(*member.parts)
            resolved = target.resolve(strict=False)
            try:
                resolved.relative_to(destination.resolve())
            except ValueError as exc:
                raise ContractError(f"ZIP 대상 경로가 검증 폴더를 벗어납니다: {member}") from exc
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, target.open("wb") as sink:
                while chunk := source.read(1024 * 1024):
                    sink.write(chunk)
            extracted.append(member.as_posix())
    return sorted(extracted)


def build_prompt(operation_id: str) -> str:
    return f"""ChatGPT Chrome 검증 루프의 전송 카나리 작업이다.

operation_id: {operation_id}

첨부한 context.zip의 CONTRACT.json과 workspace/input.txt를 읽어라.
반드시 다운로드 가능한 result.zip 하나를 만들어라.
result.zip에는 solution/input.txt만 넣어라.

이번 첫 응답은 로컬 실패 경로를 검증하기 위한 의도적인 오답이어야 한다.
solution/input.txt의 정확한 내용은 다음 한 줄이어야 한다.

BROKEN: first transport canary

후속 메시지로 feedback.zip이 오면 그 안의 검증 결과를 읽고 계약의 expected_text로
수정한 새로운 result.zip을 만들어라. 설명보다 다운로드 파일 생성을 우선하라.
"""


def prepare(run_dir: Path, fixture_path: Path) -> dict:
    if run_dir.exists():
        raise ContractError(f"실행 폴더가 이미 존재합니다: {run_dir}")
    run_dir.mkdir(parents=True)
    operation_id = str(uuid.uuid4())
    contract = {
        "schema_version": 1,
        "operation_id": operation_id,
        "expected_member": EXPECTED_MEMBER,
        "expected_text": EXPECTED_TEXT,
        "result_filename": "result.zip",
        "max_attempts": MAX_ATTEMPTS,
    }
    context_zip = run_dir / "context.zip"
    with zipfile.ZipFile(context_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("CONTRACT.json", json.dumps(contract, ensure_ascii=False, indent=2) + "\n")
        archive.writestr("workspace/input.txt", fixture_path.read_text(encoding="utf-8"))
    prompt_path = run_dir / "prompt.md"
    prompt_path.write_text(build_prompt(operation_id), encoding="utf-8")
    state = {
        "schema_version": 1,
        "operation_id": operation_id,
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "status": "prepared",
        "attempts": [],
        "conversation_url": None,
        "context_zip": str(context_zip.resolve()),
        "context_sha256": sha256_file(context_zip),
        "prompt_file": str(prompt_path.resolve()),
        "max_attempts": MAX_ATTEMPTS,
    }
    write_json(run_dir / "state.json", state)
    return state


def validate_chatgpt_url(url: str) -> str:
    normalized = url.strip()
    if not normalized.startswith("https://chatgpt.com/c/"):
        raise ContractError("일반 ChatGPT 대화 URL만 기록할 수 있습니다.")
    if any(char.isspace() for char in normalized):
        raise ContractError("ChatGPT 대화 URL에 공백이 있습니다.")
    return normalized


def record_session(run_dir: Path, url: str) -> dict:
    state_path = run_dir / "state.json"
    state = read_json(state_path)
    normalized = validate_chatgpt_url(url)
    existing = state.get("conversation_url")
    if existing and existing != normalized:
        raise ContractError("이미 기록된 대화와 다른 URL로 변경할 수 없습니다.")
    state["conversation_url"] = normalized
    state["status"] = "submitted"
    state["updated_at"] = utc_now()
    write_json(state_path, state)
    return state


def failure_fingerprint(errors: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(errors)).encode("utf-8")).hexdigest()


def create_feedback_zip(run_dir: Path, attempt: int, report: dict) -> Path:
    feedback_dir = run_dir / "feedback"
    feedback_dir.mkdir(exist_ok=True)
    feedback_zip = feedback_dir / f"feedback-{attempt:03d}.zip"
    feedback_md = f"""# Local verification failed

operation_id: {report['operation_id']}
attempt: {attempt}

Create a corrected downloadable `result.zip` in this same ChatGPT conversation.
The ZIP must contain only `{EXPECTED_MEMBER}` with this exact UTF-8 content.

```text
{EXPECTED_TEXT.rstrip()}
```

Errors are in `verification.json`. Do not repeat the previous artifact.
"""
    with zipfile.ZipFile(feedback_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("verification.json", json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        archive.writestr("feedback.md", feedback_md)
    return feedback_zip


def verify(run_dir: Path, result_zip: Path) -> tuple[dict, int]:
    state_path = run_dir / "state.json"
    state = read_json(state_path)
    if not state.get("conversation_url"):
        raise ContractError("검증 전에 ChatGPT 대화 URL을 기록해야 합니다.")
    attempt = len(state.get("attempts", [])) + 1
    if attempt > int(state.get("max_attempts", MAX_ATTEMPTS)):
        raise ContractError("최대 검증 횟수에 도달했습니다.")
    attempt_dir = run_dir / "attempts" / f"{attempt:03d}"
    extraction_dir = attempt_dir / "extracted"
    attempt_dir.mkdir(parents=True)
    errors: list[str] = []
    extracted: list[str] = []
    infrastructure_error = None
    try:
        extracted = safe_extract(result_zip, extraction_dir)
        if extracted != [EXPECTED_MEMBER]:
            errors.append(f"예상 파일 집합 {[EXPECTED_MEMBER]}과 다릅니다: {extracted}")
        target = extraction_dir / "solution" / "input.txt"
        if not target.is_file():
            errors.append(f"필수 파일이 없습니다: {EXPECTED_MEMBER}")
        else:
            observed = target.read_text(encoding="utf-8")
            if observed != EXPECTED_TEXT:
                errors.append(f"내용 불일치: expected={EXPECTED_TEXT!r}, observed={observed!r}")
    except (ContractError, zipfile.BadZipFile, UnicodeDecodeError, OSError) as exc:
        infrastructure_error = str(exc)
        errors.append(f"artifact_contract_error: {exc}")
    report = {
        "schema_version": 1,
        "operation_id": state["operation_id"],
        "conversation_url": state["conversation_url"],
        "attempt": attempt,
        "verified_at": utc_now(),
        "result_zip": str(result_zip.resolve()),
        "result_sha256": sha256_file(result_zip) if result_zip.is_file() else None,
        "extracted_files": extracted,
        "status": "pass" if not errors else "fail",
        "errors": errors,
        "failure_fingerprint": failure_fingerprint(errors) if errors else None,
        "infrastructure_error": infrastructure_error,
    }
    report_path = attempt_dir / "verification.json"
    write_json(report_path, report)
    feedback_zip = None
    if errors:
        feedback_zip = create_feedback_zip(run_dir, attempt, report)
    history = state.setdefault("attempts", [])
    repeated = bool(errors and history and history[-1].get("failure_fingerprint") == report["failure_fingerprint"])
    exhausted = attempt >= int(state.get("max_attempts", MAX_ATTEMPTS))
    history.append(
        {
            "attempt": attempt,
            "status": report["status"],
            "result_sha256": report["result_sha256"],
            "verification_file": str(report_path.resolve()),
            "feedback_zip": str(feedback_zip.resolve()) if feedback_zip else None,
            "failure_fingerprint": report["failure_fingerprint"],
        }
    )
    if not errors:
        state["status"] = "verified"
    elif repeated or exhausted:
        state["status"] = "stopped"
        state["stop_reason"] = "repeated_failure" if repeated else "max_attempts"
    else:
        state["status"] = "feedback_ready"
    state["updated_at"] = utc_now()
    write_json(state_path, state)
    return report, 0 if not errors else 2


def default_fixture() -> Path:
    return Path(__file__).resolve().parents[1] / "fixtures" / "broken.txt"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ChatGPT Chrome 검증 루프 PoC")
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--run-dir", type=Path, required=True)
    prepare_parser.add_argument("--fixture", type=Path, default=default_fixture())
    session_parser = subparsers.add_parser("record-session")
    session_parser.add_argument("--run-dir", type=Path, required=True)
    session_parser.add_argument("--url", required=True)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--run-dir", type=Path, required=True)
    verify_parser.add_argument("--result-zip", type=Path, required=True)
    status_parser = subparsers.add_parser("status")
    status_parser.add_argument("--run-dir", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "prepare":
            result = prepare(args.run_dir.resolve(), args.fixture.resolve())
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "record-session":
            result = record_session(args.run_dir.resolve(), args.url)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "verify":
            result, exit_code = verify(args.run_dir.resolve(), args.result_zip.resolve())
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return exit_code
        result = read_json(args.run_dir.resolve() / "state.json")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ContractError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

