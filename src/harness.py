# ChatGPT 브라우저 왕복과 로컬 검증 상태를 관리하는 최소 PoC 하네스다.
from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
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
MAX_VERIFIER_OUTPUT_CHARS = 64 * 1024
MAX_VERIFIER_TIMEOUT_SECONDS = 300


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


def validate_archive_path(raw_name: str) -> PurePosixPath:
    normalized = raw_name.replace("\\", "/")
    if not normalized or "\x00" in normalized:
        raise ContractError("ZIP에 비어 있거나 NUL을 포함한 경로가 있습니다.")
    member = PurePosixPath(normalized)
    if member.is_absolute() or ".." in member.parts:
        raise ContractError(f"ZIP 경로 탈출을 거부했습니다: {normalized}")
    if member.parts and ":" in member.parts[0]:
        raise ContractError(f"ZIP 드라이브 경로를 거부했습니다: {normalized}")
    return member


def validate_member(info: zipfile.ZipInfo) -> PurePosixPath:
    raw_name = info.filename.replace("\\", "/")
    member = validate_archive_path(raw_name)
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


def default_task_spec(fixture_path: Path) -> dict:
    return {
        "schema_version": 1,
        "name": "text-canary",
        "prompt": build_prompt("{operation_id}"),
        "context_files": [
            {"source": str(fixture_path.resolve()), "member": "workspace/input.txt"},
        ],
        "result": {
            "filename": "result.zip",
            "required_members": [EXPECTED_MEMBER],
            "allowed_members": [EXPECTED_MEMBER],
        },
        "verifier": {
            "kind": "exact_text",
            "member": EXPECTED_MEMBER,
            "expected_text": EXPECTED_TEXT,
        },
        "max_attempts": MAX_ATTEMPTS,
    }


def load_task_spec(spec_path: Path | None, fixture_path: Path) -> dict:
    if spec_path is None:
        return default_task_spec(fixture_path)
    spec = read_json(spec_path)
    if spec.get("schema_version") != 1:
        raise ContractError("지원하지 않는 작업 계약 버전입니다.")
    if not isinstance(spec.get("name"), str) or not spec["name"].strip():
        raise ContractError("작업 계약에 name이 필요합니다.")
    if not isinstance(spec.get("prompt"), str) or not spec["prompt"].strip():
        raise ContractError("작업 계약에 prompt가 필요합니다.")
    context_files = spec.get("context_files", [])
    if not isinstance(context_files, list):
        raise ContractError("context_files는 배열이어야 합니다.")
    normalized_context = []
    seen_context_members = set()
    for item in context_files:
        if not isinstance(item, dict) or not isinstance(item.get("source"), str) or not isinstance(item.get("member"), str):
            raise ContractError("각 context_files 항목에는 source와 member가 필요합니다.")
        source = Path(item["source"])
        if not source.is_absolute():
            source = spec_path.parent / source
        source = source.resolve()
        if not source.is_file():
            raise ContractError(f"컨텍스트 파일이 없습니다: {source}")
        member = validate_archive_path(item["member"]).as_posix()
        if member == "CONTRACT.json":
            raise ContractError("CONTRACT.json은 예약된 컨텍스트 경로입니다.")
        if member in seen_context_members:
            raise ContractError(f"중복된 컨텍스트 경로입니다: {member}")
        seen_context_members.add(member)
        normalized_context.append({"source": str(source), "member": member})
    result = spec.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("filename"), str):
        raise ContractError("작업 계약에 result.filename이 필요합니다.")
    result_filename = validate_archive_path(result["filename"])
    if len(result_filename.parts) != 1:
        raise ContractError("result.filename은 파일명 하나여야 합니다.")
    required_members = result.get("required_members", [])
    allowed_members = result.get("allowed_members")
    if not isinstance(required_members, list) or not all(isinstance(value, str) for value in required_members):
        raise ContractError("result.required_members는 문자열 배열이어야 합니다.")
    if allowed_members is not None and (
        not isinstance(allowed_members, list) or not all(isinstance(value, str) for value in allowed_members)
    ):
        raise ContractError("result.allowed_members는 문자열 배열이어야 합니다.")
    normalized_result = {
        "filename": result_filename.as_posix(),
        "required_members": [validate_archive_path(value).as_posix() for value in required_members],
        "allowed_members": (
            [validate_archive_path(value).as_posix() for value in allowed_members]
            if allowed_members is not None
            else None
        ),
    }
    if normalized_result["allowed_members"] is not None and not set(normalized_result["required_members"]).issubset(
        normalized_result["allowed_members"]
    ):
        raise ContractError("required_members는 allowed_members에 모두 포함돼야 합니다.")
    verifier = spec.get("verifier")
    if not isinstance(verifier, dict) or verifier.get("kind") not in {"exact_text", "command"}:
        raise ContractError("verifier.kind는 exact_text 또는 command여야 합니다.")
    if verifier["kind"] == "exact_text":
        if not isinstance(verifier.get("member"), str) or not isinstance(verifier.get("expected_text"), str):
            raise ContractError("exact_text 검증기에는 member와 expected_text가 필요합니다.")
        normalized_verifier = {
            "kind": "exact_text",
            "member": validate_archive_path(verifier["member"]).as_posix(),
            "expected_text": verifier["expected_text"],
        }
    else:
        argv = verifier.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(value, str) and value for value in argv):
            raise ContractError("command 검증기에는 비어 있지 않은 argv 문자열 배열이 필요합니다.")
        timeout_seconds = int(verifier.get("timeout_seconds", 60))
        if not 1 <= timeout_seconds <= MAX_VERIFIER_TIMEOUT_SECONDS:
            raise ContractError(f"검증 시간 제한은 1~{MAX_VERIFIER_TIMEOUT_SECONDS}초여야 합니다.")
        cwd_value = verifier.get("cwd", ".")
        cwd = Path(cwd_value)
        if not cwd.is_absolute():
            cwd = spec_path.parent / cwd
        cwd = cwd.resolve()
        if not cwd.is_dir():
            raise ContractError(f"검증 명령 작업 폴더가 없습니다: {cwd}")
        normalized_verifier = {
            "kind": "command",
            "argv": argv,
            "cwd": str(cwd),
            "timeout_seconds": timeout_seconds,
        }
    max_attempts = int(spec.get("max_attempts", MAX_ATTEMPTS))
    if not 1 <= max_attempts <= 10:
        raise ContractError("max_attempts는 1~10이어야 합니다.")
    return {
        "schema_version": 1,
        "name": spec["name"].strip(),
        "prompt": spec["prompt"],
        "context_files": normalized_context,
        "result": normalized_result,
        "verifier": normalized_verifier,
        "max_attempts": max_attempts,
        "spec_source": str(spec_path.resolve()),
    }


def prepare(run_dir: Path, fixture_path: Path, spec_path: Path | None = None) -> dict:
    if run_dir.exists():
        raise ContractError(f"실행 폴더가 이미 존재합니다: {run_dir}")
    task_spec = load_task_spec(spec_path, fixture_path)
    run_dir.mkdir(parents=True)
    operation_id = str(uuid.uuid4())
    result_contract = task_spec["result"]
    verifier = task_spec["verifier"]
    contract = {
        "schema_version": 1,
        "operation_id": operation_id,
        "task_name": task_spec["name"],
        "result": result_contract,
        "verifier_kind": verifier["kind"],
        "max_attempts": task_spec["max_attempts"],
    }
    if verifier["kind"] == "exact_text":
        contract["expected_member"] = verifier["member"]
        contract["expected_text"] = verifier["expected_text"]
    context_zip = run_dir / "context.zip"
    with zipfile.ZipFile(context_zip, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("CONTRACT.json", json.dumps(contract, ensure_ascii=False, indent=2) + "\n")
        for item in task_spec["context_files"]:
            archive.write(item["source"], item["member"])
    prompt_path = run_dir / "prompt.md"
    prompt_path.write_text(task_spec["prompt"].replace("{operation_id}", operation_id), encoding="utf-8")
    state = {
        "schema_version": 1,
        "operation_id": operation_id,
        "task_name": task_spec["name"],
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "status": "prepared",
        "attempts": [],
        "submissions": [],
        "conversation_url": None,
        "context_zip": str(context_zip.resolve()),
        "context_sha256": sha256_file(context_zip),
        "prompt_file": str(prompt_path.resolve()),
        "result": result_contract,
        "verifier": verifier,
        "max_attempts": task_spec["max_attempts"],
        "spec_source": task_spec.get("spec_source"),
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


def record_submission(run_dir: Path, url: str, kind: str) -> dict:
    state_path = run_dir / "state.json"
    state = read_json(state_path)
    normalized = validate_chatgpt_url(url)
    existing = state.get("conversation_url")
    if existing and existing != normalized:
        raise ContractError("이미 기록된 대화와 다른 URL로 변경할 수 없습니다.")
    if kind not in {"initial", "feedback"}:
        raise ContractError("제출 종류는 initial 또는 feedback이어야 합니다.")
    if kind == "initial":
        if state.get("status") not in {"prepared", "submitted"}:
            raise ContractError("초기 요청을 기록할 수 없는 상태입니다.")
        attempt = 0
        next_status = "submitted"
    else:
        if state.get("status") not in {"feedback_ready", "feedback_submitted"}:
            raise ContractError("피드백 요청을 기록할 수 없는 상태입니다.")
        attempt = len(state.get("attempts", []))
        next_status = "feedback_submitted"
    submission_key = f"{state['operation_id']}:{kind}:{attempt}"
    submissions = state.setdefault("submissions", [])
    duplicate = next((item for item in submissions if item.get("submission_key") == submission_key), None)
    if duplicate:
        if duplicate.get("conversation_url") != normalized:
            raise ContractError("같은 제출 키가 다른 대화 URL에 기록돼 있습니다.")
        return state
    state["conversation_url"] = normalized
    submissions.append(
        {
            "submission_key": submission_key,
            "kind": kind,
            "attempt": attempt,
            "conversation_url": normalized,
            "submitted_at": utc_now(),
        }
    )
    state["status"] = next_status
    state["updated_at"] = utc_now()
    write_json(state_path, state)
    return state


def record_session(run_dir: Path, url: str) -> dict:
    return record_submission(run_dir, url, "initial")


def next_action(run_dir: Path) -> dict:
    state = read_json(run_dir / "state.json")
    status = state.get("status")
    result_filename = state.get("result", {}).get("filename", "result.zip")
    base = {
        "schema_version": 1,
        "operation_id": state["operation_id"],
        "conversation_url": state.get("conversation_url"),
        "status": status,
    }
    if status == "prepared":
        return {
            **base,
            "action": "submit_initial",
            "submission_key": f"{state['operation_id']}:initial:0",
            "prompt_file": state["prompt_file"],
            "attachments": [state["context_zip"]],
            "expected_download": result_filename,
        }
    if status == "feedback_ready":
        latest = state["attempts"][-1]
        attempt = latest["attempt"]
        return {
            **base,
            "action": "submit_feedback",
            "submission_key": f"{state['operation_id']}:feedback:{attempt}",
            "prompt": "첨부한 feedback.zip을 읽고 같은 대화에서 수정된 결과물을 만들어라.",
            "attachments": [latest["feedback_zip"]],
            "expected_download": result_filename,
        }
    if status in {"submitted", "feedback_submitted"}:
        return {
            **base,
            "action": "await_download",
            "expected_download": result_filename,
            "attempt": len(state.get("attempts", [])) + 1,
        }
    return {**base, "action": "none"}


def failure_fingerprint(errors: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(errors)).encode("utf-8")).hexdigest()


def truncate_output(value: str) -> str:
    if len(value) <= MAX_VERIFIER_OUTPUT_CHARS:
        return value
    return value[:MAX_VERIFIER_OUTPUT_CHARS] + "\n...[truncated]\n"


def run_command_verifier(verifier: dict, extraction_dir: Path, run_dir: Path, result_zip: Path) -> dict:
    replacements = {
        "{extracted_dir}": str(extraction_dir.resolve()),
        "{run_dir}": str(run_dir.resolve()),
        "{result_zip}": str(result_zip.resolve()),
    }
    argv = []
    for value in verifier["argv"]:
        expanded = value
        for placeholder, replacement in replacements.items():
            expanded = expanded.replace(placeholder, replacement)
        argv.append(expanded)
    try:
        completed = subprocess.run(
            argv,
            cwd=verifier["cwd"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=verifier["timeout_seconds"],
            shell=False,
            check=False,
        )
        return {
            "argv": argv,
            "cwd": verifier["cwd"],
            "exit_code": completed.returncode,
            "stdout": truncate_output(completed.stdout),
            "stderr": truncate_output(completed.stderr),
            "timed_out": False,
        }
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        return {
            "argv": argv,
            "cwd": verifier["cwd"],
            "exit_code": None,
            "stdout": truncate_output(stdout),
            "stderr": truncate_output(stderr),
            "timed_out": True,
        }


def create_feedback_zip(run_dir: Path, attempt: int, report: dict, result_contract: dict, verifier: dict) -> Path:
    feedback_dir = run_dir / "feedback"
    feedback_dir.mkdir(exist_ok=True)
    feedback_zip = feedback_dir / f"feedback-{attempt:03d}.zip"
    exact_requirement = ""
    if verifier["kind"] == "exact_text":
        exact_requirement = f"""
The ZIP must contain `{verifier['member']}` with this exact UTF-8 content.

```text
{verifier['expected_text'].rstrip()}
```
"""
    feedback_md = f"""# Local verification failed

operation_id: {report['operation_id']}
attempt: {attempt}

Create a corrected downloadable `{result_contract['filename']}` in this same ChatGPT conversation.
{exact_requirement}

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
    result_contract = state.get(
        "result",
        {"filename": "result.zip", "required_members": [EXPECTED_MEMBER], "allowed_members": [EXPECTED_MEMBER]},
    )
    verifier = state.get(
        "verifier",
        {"kind": "exact_text", "member": EXPECTED_MEMBER, "expected_text": EXPECTED_TEXT},
    )
    errors: list[str] = []
    extracted: list[str] = []
    infrastructure_error = None
    verifier_result = None
    try:
        extracted = safe_extract(result_zip, extraction_dir)
        required_members = sorted(result_contract.get("required_members", []))
        missing_members = sorted(set(required_members) - set(extracted))
        if missing_members:
            errors.append(f"필수 파일이 없습니다: {missing_members}")
        allowed_members = result_contract.get("allowed_members")
        if allowed_members is not None and extracted != sorted(allowed_members):
            errors.append(f"예상 파일 집합 {sorted(allowed_members)}과 다릅니다: {extracted}")
        if not errors and verifier["kind"] == "exact_text":
            target = extraction_dir.joinpath(*PurePosixPath(verifier["member"]).parts)
            if not target.is_file():
                errors.append(f"필수 파일이 없습니다: {verifier['member']}")
            else:
                observed = target.read_text(encoding="utf-8")
                if observed != verifier["expected_text"]:
                    errors.append(f"내용 불일치: expected={verifier['expected_text']!r}, observed={observed!r}")
        elif not errors:
            verifier_result = run_command_verifier(verifier, extraction_dir, run_dir, result_zip)
            if verifier_result["timed_out"]:
                errors.append(f"로컬 검증 명령이 {verifier['timeout_seconds']}초 안에 끝나지 않았습니다.")
            elif verifier_result["exit_code"] != 0:
                errors.append(f"로컬 검증 명령 실패: exit_code={verifier_result['exit_code']}")
    except (ContractError, zipfile.BadZipFile, UnicodeDecodeError, OSError) as exc:
        infrastructure_error = str(exc)
        errors.append(f"artifact_contract_error: {exc}")
    fingerprint_values = list(errors)
    if verifier_result is not None:
        stable_verifier_result = {
            "exit_code": verifier_result["exit_code"],
            "stdout": verifier_result["stdout"],
            "stderr": verifier_result["stderr"],
            "timed_out": verifier_result["timed_out"],
        }
        fingerprint_values.append(json.dumps(stable_verifier_result, ensure_ascii=False, sort_keys=True))
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
        "failure_fingerprint": failure_fingerprint(fingerprint_values) if errors else None,
        "infrastructure_error": infrastructure_error,
        "verifier": verifier_result,
    }
    report_path = attempt_dir / "verification.json"
    write_json(report_path, report)
    feedback_zip = None
    if errors:
        feedback_zip = create_feedback_zip(run_dir, attempt, report, result_contract, verifier)
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
    parser = argparse.ArgumentParser(description="ChatGPT Chrome 범용 검증 루프")
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--run-dir", type=Path, required=True)
    prepare_parser.add_argument("--fixture", type=Path, default=default_fixture())
    prepare_parser.add_argument("--spec", type=Path)
    session_parser = subparsers.add_parser("record-session")
    session_parser.add_argument("--run-dir", type=Path, required=True)
    session_parser.add_argument("--url", required=True)
    submission_parser = subparsers.add_parser("record-submission")
    submission_parser.add_argument("--run-dir", type=Path, required=True)
    submission_parser.add_argument("--url", required=True)
    submission_parser.add_argument("--kind", choices=["initial", "feedback"], required=True)
    action_parser = subparsers.add_parser("next-action")
    action_parser.add_argument("--run-dir", type=Path, required=True)
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
            result = prepare(args.run_dir.resolve(), args.fixture.resolve(), args.spec.resolve() if args.spec else None)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "record-session":
            result = record_session(args.run_dir.resolve(), args.url)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "record-submission":
            result = record_submission(args.run_dir.resolve(), args.url, args.kind)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return 0
        if args.command == "next-action":
            result = next_action(args.run_dir.resolve())
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
