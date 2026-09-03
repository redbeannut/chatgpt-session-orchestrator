# 범용 ChatGPT 로컬 검증 루프

이 프로젝트의 핵심은 특정 파일 형식이 아니라 작업 계약과 검증기를 교체할 수 있는
반복 실행 흐름이다.

```text
작업 명세 JSON
  ↓
로컬 폴더 접근 확인
  ├─ 확인됨 → 직접 파일 사용
  └─ 미확인 → context packer → briefing.md + context_files
  ↓
설치된 chatgpt-delegate
  ↓
Chat 또는 Work 대화
  ↓
응답 또는 result.zip
  ├─ 텍스트 → 로컬 종합
  └─ result.zip → 안전한 압축 해제 → 로컬 검증
       ├─ 통과 → verified
       └─ 실패 → feedback.zip → 같은 대화 재제출

legacy fallback → browser_bridge_loop.mjs
```

## 계층

### 작업 계약

작업별 JSON 명세가 프롬프트, 컨텍스트 파일, 예상 결과 파일명, 필수·허용 ZIP
멤버, 검증 방식, 최대 반복 횟수를 선언한다. 현재 예시는
`specs/command-canary.json`이다.

### 전송 어댑터

기본 전송은 설치된 `chatgpt-delegate`다. 새 대화 생성, 파일 첨부, 응답 대기, 정확한
파일명 다운로드는 Delegate에 맡긴다. 이 저장소는 작업 계약과 로컬 검증만 소유한다.

데스크톱 Chat 또는 Work가 필요한 폴더를 열고 접근 권한을 확인한 경우 그 파일을 직접
사용한다. 브라우저 Chat 또는 접근이 불명확한 작업은 context packer로 최소 자료를
첨부한다. 사이드바 공유나 대화 고정은 로컬 접근 증거가 아니다.

레거시 브라우저 구현은 하네스의 `next-action` 출력만 소비하며 다음 동작을 책임진다.

- `submit_initial`에서 새 대화에 프롬프트와 컨텍스트를 한 번만 제출한다.
- `await_download`에서 정확한 결과 파일명만 내려받는다.
- `submit_feedback`에서 같은 대화에 실패 자료를 한 번만 제출한다.
- 각 제출 뒤 `record-submission`으로 제출 키와 대화 URL을 고정한다.

`browser-bridge`는 Delegate 또는 레거시 경로가 Chrome을 제어할 때 사용하는 기반이다.
`codex-chatgpt-control`은 ChatGPT 화면 상태와 제출·대기·다운로드 규칙을 담당한다.

레거시 실행 경로는 `scripts/run_browser_loop.ps1`에서 서버를 확인한 뒤
`src/browser_bridge_loop.mjs`를 호출한다. 실행기는 Browser Bridge의 공개 MCP 도구만
사용하며 ChatGPT의 비공개 API를 호출하지 않는다. 새 대화는 정식 `/c/<id>` URL이
확정된 뒤에만 기록하고, 닫힌 대화 탭은 기록된 URL로 다시 열어 재개한다. 실행 보고서는
프롬프트 본문이나 토큰 없이 제출 키·첨부 파일명·검증 해시만 저장한다.

브라우저 변경 직전에는 `pending-submission.json`을 먼저 기록한다. 프로세스가 전송
직후 종료되면 입력창 또는 대화 본문의 제출 키를 확인해, 초안만 남은 경우에만 전송하고
이미 대화에 들어간 경우에는 기록만 복구한다. 전송 뒤에는 `pending-download.json`에
그 시점의 실제 결과 요소 개수를 저장한다. 재시작 후에도 이 값을 사용하므로 이전
결과의 버튼·링크 표현 수가 달라도 새 결과를 과거 결과로 오인하지 않는다. 두 저널은
상태 기록 또는 검증이 완료된 뒤에만 제거한다.

명시한 탭 ID는 최초 제출 전에 정확한 `https://chatgpt.com` 출처인지 검사한다. 대화
URL은 `/c/<UUID>` 또는 `/g/<project>/c/<UUID>`만 인정한다. ChatGPT 파일 버튼이
서명된 `/backend-api/estuary/content` URL로 이동시키는 환경에서는 브라우저 세션의
다운로드 기능으로 저장한 뒤 고정된 대화 URL로 복귀한다.

작업 명세에 `project_url`이 있으면 `/g/<project>/project` 홈만 최초 진입점으로
인정하고, 생성·재개되는 모든 대화가 같은 프로젝트 키를 갖는지 검사한다. 프로젝트는
공유 지식과 지침의 경계일 뿐 조정 상태 저장소로 사용하지 않는다.

### 다중 작업자 확장 원칙

Codex가 최종 답변과 로컬 검증을 소유하는 중앙 감독자이고, 프로젝트 안의 각 ChatGPT
대화는 한 가지 산출물 계약만 맡는 작업자다. `src/orchestrator.mjs`가 최대 3개 작업자의
`worker_id`, project URL, Chrome tab ID, capability와 마지막 conversation URL을
관리한다. 작업자는 같은 project URL과 필요한 capability가 모두 맞을 때만 임대된다.

`BrowserSessionAdapter`는 기존 `runLoop()`를 그대로 호출하는 얇은 경계다. worker가
등록한 tab ID만 실행 옵션에 주입하므로 ZIP 다운로드·로컬 검증·feedback·실패 지문
차단은 기존 경로를 재사용한다.

`src/orchestrator_cli.mjs`는 JSON manifest를 읽는 얇은 실행 경계다. 작업별 spec으로
아직 없는 `runDir`만 준비하고 기존 작업자 등록·실행 함수를 호출한다. 라이브 계정 보호를
위해 CLI에서는 제출 간격 60초 미만을 허용하지 않는다. 임의의 기존 대화 가져오기는
지원하지 않으며 새 대화 또는 이벤트 로그에 이미 결합된 대화만 사용한다.

조정 상태의 진실 원천은 ChatGPT DOM이나 프로젝트 파일이 아니라 하나의 coordinator가
쓰는 `orchestrator-events.jsonl`이다. 다음 이벤트를 순서대로 재생하면 프로세스 재시작
뒤에도 임대 상태와 완료 여부를 복구할 수 있다.

```text
WORKER_REGISTERED
OPERATION_CREATED
WORKER_LEASED
OPERATION_STATE_CHANGED
WORKER_BOUND
WORKER_RELEASED
```

외부 작업 상태는 `CREATED → LEASED → RUNNING → COMPLETED | FAILED`로 제한한다.
RUNNING 상태에서 프로세스가 종료되면 같은 operation을 다시 호출해 동일 worker와 기존
`runDir`의 제출 저널을 재사용한다. 완료 이벤트 직후 중단된 경우에는 재호출 시 남은
worker lease만 해제한다. 완료된 worker의 conversation URL은 다음 operation의 준비
상태에 주입해 같은 프로젝트 대화를 이어간다. 실행 중 대화를 만든 뒤 실패한 경우도
확인된 conversation URL을 worker에 먼저 기록하고 lease를 해제한다. 작업자끼리 직접 통신하거나 프로젝트
파일을 메시지 버스로 쓰는 기능은 추가하지 않는다.

실제 프로젝트 대화는 홈의 `g-p-<32hex>` 뒤에 `-<name-slug>`가 붙을 수 있다. 기본
32자리 프로젝트 ID가 정확히 같은 경우만 같은 프로젝트로 인정한다. 병렬 실행은 한
작업이 실패해도 나머지를 끝까지 기다려 lease를 정리하며, ChatGPT 요청 제한 안내는
재시도하지 않고 즉시 중단한다. 같은 계정의 세 worker는 제출 시작을 60초씩 분산하고,
제한 감지 시 15분 `ACCOUNT_BLOCKED` 이벤트를 기록해 재시작 뒤에도 남은 제출을 막는다.

### 검증 어댑터

두 종류를 지원한다.

- `exact_text`는 작은 계약·전송 카나리에 사용한다.
- `command`는 로컬에서 미리 지정한 명령을 `shell=False`로 실행한다.

명령형 검증기는 `{extracted_dir}`, `{run_dir}`, `{result_zip}` 자리표시자를 받을 수
있다. 결과 ZIP 내부의 스크립트는 자동 실행하지 않는다. 프로젝트별 테스트,
문서 렌더링, 빌드, 이미지 비교, 스키마 검증 등을 독립 검증기로 연결할 수 있다.

## 상태와 중단 조건

`prepared → submitted → feedback_ready → feedback_submitted → verified`가 정상 흐름이다.
동일 실패 지문이 연속으로 나오거나 최대 반복 횟수에 도달하면 `stopped`가 된다.
`operation_id:kind:attempt` 제출 키는 타임아웃 뒤 같은 요청을 중복 제출하는 것을
막는다.

## 신뢰 경계

- 브라우저에서 내려받은 ZIP은 신뢰하지 않는다.
- ZIP 경로 탈출, 절대경로, 드라이브 경로, 심볼릭 링크와 크기 초과를 거부한다.
- 검증 명령은 로컬 작업 명세에만 둔다.
- 프롬프트나 결과물이 검증 명령을 바꿀 수 없다.
- 브리지 토큰은 저장소 밖 사용자 프로필에 두고 출력하거나 커밋하지 않는다.
