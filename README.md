# ChatGPT Browser Loop PoC

Codex가 로그인된 Chrome의 ChatGPT 대화를 조작하고, 생성된 ZIP을 로컬에서
검증한 뒤 실패 결과를 같은 대화로 돌려보내는 범용 실행 하네스다.

관련 노트는 [[../0. 하네스 엔지니어링 백과사전]]이다.
구조와 확장 지점은 [[ARCHITECTURE]]에 정리했다.

## 범위

1. `context.zip`과 최초 요청문을 생성한다.
2. Codex가 Chrome의 새 ChatGPT 대화에 둘을 제출한다.
3. 첫 `result.zip`은 의도적으로 실패해야 한다.
4. 로컬 검증기가 `feedback.zip`을 만든다.
5. 같은 ChatGPT 대화에 피드백을 제출한다.
6. 두 번째 `result.zip`이 로컬 검증을 통과해야 한다.

브라우저 전송은 `browser-bridge`로 로그인된 Chrome을 제어한다. 상태와 ZIP 계약은
브리지에 종속되지 않으며, Codex는 `next-action`에 따라 업로드·다운로드·후속 제출을
수행한다.

## 실측 결과

2026-09-02에 로그인된 Chrome의 독립 ChatGPT 대화에서 `live-001`을 실행했다.

| 단계 | 결과 | 증거 |
| --- | --- | --- |
| 첫 결과 다운로드 | 성공 | SHA-256 `050dde37245a5a4ef2c29641ca9602d1583e49e1f0885d4f942448e48d8bb4a3` |
| 첫 로컬 검증 | 의도대로 실패 | 종료 코드 `2`, 실제 값 `BROKEN: first transport canary\n` |
| 같은 대화 피드백 | 성공 | 동일 대화 URL에서 실패 지문과 기대값 전달 |
| 수정 결과 다운로드 | 성공 | SHA-256 `956ae3727f55cfaee9e14ceda1188d17cec9a6fadfc08def317580285887a515` |
| 두 번째 로컬 검증 | 통과 | 종료 코드 `0`, 상태 `verified` |

2026-09-03에는 `browser-bridge`의 실제 파일 입력을 사용해 `bridge-live-001` 전체
왕복을 다시 실행했다.

| 단계 | 결과 | 증거 |
| --- | --- | --- |
| `context.zip` 업로드 | 성공 | 509바이트 파일이 로그인된 Chrome의 새 ChatGPT 대화에 첨부됨 |
| 최초 요청 제출 | 성공 | 대화 URL `https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39` 고정 |
| 첫 결과 다운로드 | 성공 | SHA-256 `afe6cb62d6037aa2e1ed0d3232293aa9125c89e80b0336715b8251bf91555050` |
| 첫 로컬 검증 | 의도대로 실패 | 종료 코드 `2`, `feedback-001.zip` 자동 생성 |
| 같은 대화 피드백 업로드 | 성공 | 1,070바이트 `feedback.zip` 첨부 후 동일 URL에 제출 |
| 수정 결과 다운로드 | 성공 | SHA-256 `c6db9755466c3eb2aeba2b5a021a7e5d98cf41cbf2088a8cae363f177e66c72a` |
| 두 번째 로컬 검증 | 통과 | 종료 코드 `0`, 최종 상태 `verified` |

따라서 파일 내용을 본문에 대신 넣지 않고도 실제 업로드·다운로드·로컬 검증·동일
대화 수정 요청이 모두 동작한다. 특정 문서 형식은 이후 작업별 검증기 중 하나다.

## 범용 작업 계약

`specs/command-canary.json`처럼 작업마다 다음 항목을 선언한다.

- ChatGPT에 보낼 프롬프트와 컨텍스트 파일 목록.
- 기대하는 결과 ZIP 이름과 필수·허용 파일 집합.
- `exact_text` 또는 로컬 `command` 검증기.
- 최대 반복 횟수.

명령형 검증기는 로컬 명세에 지정된 argv만 `shell=False`로 실행한다. 다운로드한
결과물에 포함된 스크립트는 자동 실행하지 않는다.

## 실행

```powershell
python src/harness.py prepare --run-dir runs/poc-001
python src/harness.py next-action --run-dir runs/poc-001
python src/harness.py record-session --run-dir runs/poc-001 --url "https://chatgpt.com/c/..."
python src/harness.py verify --run-dir runs/poc-001 --result-zip runs/poc-001/downloads/result.zip
python src/harness.py status --run-dir runs/poc-001
```

작업별 로컬 검증 명령을 쓰는 범용 실행은 다음과 같다.

```powershell
python src/harness.py prepare --run-dir runs/task-001 --spec specs/command-canary.json
python src/harness.py next-action --run-dir runs/task-001
python src/harness.py record-submission --run-dir runs/task-001 --kind initial --url "https://chatgpt.com/c/..."
python src/harness.py verify --run-dir runs/task-001 --result-zip runs/task-001/downloads/result.zip
```

실패 뒤 `next-action`은 `submit_feedback`과 고유 제출 키를 반환한다. 실제 제출 뒤
`record-submission --kind feedback`을 기록하면 다시 `await_download` 상태가 된다.

## Browser Bridge 검증 상태

- 소스와 빌드는 `C:\Users\admin\tools\browser-bridge`에 설치했다.
- 로컬 서버는 `127.0.0.1:8765`에서 동작한다.
- 토큰은 저장소 밖 `C:\Users\admin\.browser-bridge\token`에 있다.
- Codex MCP `browser-bridge`와 ChatGPT Surface Control 플러그인을 등록했다.
- 재기동은 `powershell -File scripts/start_browser_bridge.ps1`로 수행한다.
- Chrome 확장 0.16.0을 등록했고 health의 `extensionConnected: true`를 확인했다.
- `bridge-live-001`에서 컨텍스트와 피드백의 실제 파일 업로드를 확인했다.

Chrome 재설치나 프로필 변경으로 확장이 사라진 경우에만
`C:\Users\admin\tools\browser-bridge\extension`을 압축 해제 확장으로 다시 등록하고,
옵션 화면에서 위 토큰 파일로 **Save & connect**를 수행한다.

첫 검증 실패의 종료 코드는 `2`다. 인프라 또는 계약 오류는 `1`, 통과는 `0`이다.

## 안전 경계

- ZIP 경로 탈출, 절대경로, 드라이브 경로, 심볼릭 링크를 거부한다.
- 파일 수, 단일 파일 크기, 전체 압축 해제 크기를 제한한다.
- 정확한 `solution/input.txt`만 성공 판정에 사용한다.
- ChatGPT 대화 URL과 `operation_id`를 로컬 상태에 기록한다.
- 동일 실패가 반복되거나 최대 3회에 도달하면 중단 대상으로 표시한다.
- 다운로드한 스크립트는 실행하지 않는다.

## 테스트

```powershell
python -m unittest discover -s tests -v
```
