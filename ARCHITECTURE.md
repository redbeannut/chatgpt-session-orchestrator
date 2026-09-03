# 범용 ChatGPT 로컬 검증 루프

이 프로젝트의 핵심은 특정 파일 형식이 아니라 작업 계약과 검증기를 교체할 수 있는
반복 실행 흐름이다.

```text
작업 명세 JSON
  ↓
context.zip + prompt.md + operation_id
  ↓
브라우저 전송 어댑터
  ↓
동일한 ChatGPT 대화에서 result.zip 생성
  ↓
안전한 압축 해제
  ↓
로컬 검증 어댑터
  ├─ 통과 → verified
  └─ 실패 → feedback.zip → 같은 대화 재제출
```

## 계층

### 작업 계약

작업별 JSON 명세가 프롬프트, 컨텍스트 파일, 예상 결과 파일명, 필수·허용 ZIP
멤버, 검증 방식, 최대 반복 횟수를 선언한다. 현재 예시는
`specs/command-canary.json`이다.

### 전송 어댑터

하네스의 `next-action` 출력만 소비한다. 브라우저 구현은 다음 동작을 책임진다.

- `submit_initial`에서 새 대화에 프롬프트와 컨텍스트를 한 번만 제출한다.
- `await_download`에서 정확한 결과 파일명만 내려받는다.
- `submit_feedback`에서 같은 대화에 실패 자료를 한 번만 제출한다.
- 각 제출 뒤 `record-submission`으로 제출 키와 대화 URL을 고정한다.

`browser-bridge`는 실제 Chrome 입출력을 담당하고, `codex-chatgpt-control`은
ChatGPT 화면 상태와 제출·대기·다운로드 규칙을 담당한다.

현재 개인용 실행 경로는 `scripts/run_browser_loop.ps1`에서 서버를 확인한 뒤
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
