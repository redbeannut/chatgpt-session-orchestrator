# ChatGPT Local Verification Loop

Codex가 작업마다 가장 짧은 검증된 전송 경로를 선택해 ChatGPT 대화를 맡기고, 응답이나
생성 파일을 로컬에서 검증한 뒤 실패 결과를 같은 대화로 돌려보내는 범용 실행 하네스다.
앱 내부 task 도구, 직접 Browser Bridge, 설치된 `chatgpt-delegate`를 한 단계 안에서
중첩하지 않고 용도별로 선택한다.

관련 노트는 [[../0. 하네스 엔지니어링 백과사전]]이다.
구조와 확장 지점은 [[ARCHITECTURE]]에 정리했다.

## 범위

1. 작업 요청과 필요한 경우에만 `context.zip`을 준비한다.
2. Codex가 선택한 전송 경로로 ChatGPT 대화에 요청을 제출한다.
3. 텍스트 응답은 바로 종합하고 파일 산출물은 로컬 검증한다.
4. 검증 실패 시 `feedback.zip`을 같은 대화에 제출한다.
5. 수정된 산출물이 로컬 검증을 통과할 때까지 계약 범위에서 반복한다.

상태와 ZIP 계약은 전송 방식에 종속되지 않는다. 새 Chat 또는 Work의 복합 작업은
`chatgpt-delegate`, 기존 대화의 읽기·텍스트 후속은 앱 내부 task 도구, 기존 웹 대화의
파일 왕복은 이 저장소의 Browser Bridge 실행기가 담당한다.

## 권장 실행 경로

새 작업은 `$gpt-web-orchestrator`로 시작한다. 스킬은 아래 순서로 가장 짧은 경로를
선택하고 최대 3개 대화를 조정한다.

| 작업 | 우선 경로 |
| --- | --- |
| 로컬 파일 수정·테스트 | Codex 로컬 프로젝트 |
| 기존 대화 검색·읽기·텍스트 후속 | 앱 내부 task 도구 |
| 기존 웹 대화의 파일 업로드·다운로드 | 정확한 대화 URL의 Browser Bridge |
| 새 Chat/Work, 설정 확인, 장기 진행·조향·복합 산출물 | `chatgpt-delegate` |
| 2~3개 worker 종합 | 오케스트레이터가 작업별 우선 경로 선택 |

한 단계에서는 하나의 경로만 사용한다. 실패했다고 모든 경로를 차례로 탐색하지 않고,
구조화된 blocker가 다음 경로의 capability와 맞을 때만 전환한다. 대상 로컬 폴더 접근이
실제로 확인되면 파일을 다시 포장하지 않는다. 브라우저 Chat이거나 로컬 접근이 확인되지
않으면 context packer로 필요한 파일만 검토 후 첨부한다. 파일은 존재 여부와 크기를 먼저
검사하며 0바이트 파일은 브라우저를 열기 전에 거부한다.

## 경로 선택 근거

2026-09-03 앱 내부에서 기존 ChatGPT 대화 50개를 포함한 목록 조회는 2.63초, 지정 대화
최근 2턴 읽기는 4.57초였다. 같은 대화에 빈 `fish.txt`를 브라우저로 첨부한 시험은
ChatGPT가 첨부 카드를 만들지 않아 제출 전에 중단됐다. 이 결과를 반영해 텍스트 조회는
앱 내부 경로를 유지하고, 직접 파일 경로는 0바이트 사전 차단과 일반 파일 입력 선택을
추가했다. 시간 수치는 네트워크와 앱 상태에 따라 달라지므로 경로 선택의 보조 지표다.

OpenAI의 [프로젝트 안내](https://learn.chatgpt.com/es-419/docs/projects)는 ChatGPT
프로젝트 자료와 로컬 프로젝트 폴더를 구분하고, 특정 대화에만 필요한 파일은 그 대화에
직접 첨부하도록 안내한다. [브라우저 확장 안내](https://learn.chatgpt.com/es-419/docs/chrome-extension)는
Chrome 파일 업로드와 브라우저 제어를 별도 브라우저 capability로 설명한다. 공개 구현 중
[Playwright MCP](https://github.com/microsoft/playwright-mcp)는 고처리량 작업에서 CLI와
skill의 낮은 오버헤드를, 지속 상태·탐색 작업에서는 MCP의 장점을 구분한다.
[ask-bridge](https://github.com/doggy8088/ask-bridge)와
[OpenCLI](https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/browser/chatgpt.md)도 기존
브라우저 세션 재사용과 history·read·send·upload 동작 분리를 택한다.

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

2026-09-03에는 `run_browser_loop.ps1` 한 명령으로 `auto-command-live-003`을 실행했다.
명령형 로컬 검증기를 사용해 첫 결과 실패, 자동 피드백 업로드, 두 번째 결과 통과를
사람의 브라우저 조작 없이 완료했다. 첫 결과 SHA-256은
`32398647a5bff667e049b5af260ed934f9892e08a4dfd9ac02dc96cbf22887a0`, 수정 결과는
`c55d8dff91934441e8fb87fc41e588d80581cdba4af7921d1e3a2c10a42eec95`이며 최종 상태는
`verified`다.

같은 날 `auto-recovery-live-002`에서는 최초 메시지 전송 직후 프로세스를 의도적으로
종료하고 같은 명령을 다시 실행했다. 제출 저널의 키를 대화 본문에서 확인해 중복
메시지 없이 복구했으며, 첫 결과 실패와 같은 대화의 피드백 재제출 뒤 두 번째 결과가
통과했다. 대화 URL은
`https://chatgpt.com/c/6a98ff05-22f0-83ee-b3ad-a36a56179cc7`, 첫 결과 SHA-256은
`4766af15b0d76a8f641513789dd2ad5e401430790a82cb267ae410839f0d2e3b`, 수정 결과는
`f2146a34572e38925b0bad804ba5a56d8a968ab36da02a4f54333bee47308788`이다. 완료 후 다시
실행해 종료 코드 0, 제출 2건과 고유 제출 키 2개, 보류 저널 0개를 확인했다. 별도
오탭 시험에서는 `chatgpt.site` 탭을 `-TabId`로 지정해도 제출 0건으로 차단됐다.

같은 날 `auto-release-live-002`에서는 숨겨진 파일 입력을 CSS 선택자로 복구하고,
서명 URL 직접 저장 뒤 원래 대화로 돌아오는 경로를 다시 검증했다. 실행을 결과 대기
중 중단했다가 같은 폴더로 재개해 첫 결과 실패와 피드백 제출, 두 번째 결과 통과까지
완료했다. 자동화 보고서에는 두 다운로드 모두 `bridge-download-resource`, 대화 복귀
성공으로 기록됐고 최종 상태는 `verified`다.

## 범용 작업 계약

`specs/command-canary.json`처럼 작업마다 다음 항목을 선언한다.

특정 ChatGPT 프로젝트에서 새 대화를 시작하려면 작업 명세 최상위에 주소창에서
복사한 프로젝트 홈 URL을 추가한다.

```json
{
  "project_url": "https://chatgpt.com/g/g-p-example/project"
}
```

실행기는 프로젝트 홈에서만 최초 요청을 제출하고, 생성된 대화가 같은
`/g/<project>/c/<UUID>` 범위에 속하는지 확인한다. 일반 ChatGPT 탭이나 다른
프로젝트 탭을 `-TabId`로 지정하면 전송 전에 중단한다.

- ChatGPT에 보낼 프롬프트와 컨텍스트 파일 목록.
- 기대하는 결과 ZIP 이름과 필수·허용 파일 집합.
- `exact_text` 또는 로컬 `command` 검증기.
- 최대 반복 횟수.

명령형 검증기는 로컬 명세에 지정된 argv만 `shell=False`로 실행한다. 다운로드한
결과물에 포함된 스크립트는 자동 실행하지 않는다.

## 필요할 때만 쓰는 context packer

`src/context_packer.py`는 대상 Chat이 Codex 메모리와 로컬 경로를 볼 수 없을 때 선택한
텍스트 파일을 안정적인 줄 번호와 함께 `briefing.md`에 넣고, 이미지·문서 같은 허용
바이너리는 별도 첨부 목록으로 만든다. 선택 파일 지도, Git diff, 예상 토큰, 실제 포함
용량, 비밀·대용량·미지원 파일의 차단 사유를 `.context.json`에 기록한다.

데스크톱 Chat 또는 Work에서 정확한 로컬 폴더 접근이 확인됐다면 이 단계는 생략한다.
같은 앱에 보이거나 고정됐다는 사실만으로 접근 가능하다고 판단하지 않는다.

먼저 아무 파일도 쓰지 않는 미리보기를 확인한다.

```powershell
python src/context_packer.py --config specs/context-pack-example.json `
  --output runs/context-preview/briefing.md --dry-run
```

확인 후 `--dry-run`만 빼면 `briefing.md`와 `briefing.context.json`이 생성된다. 보고서의
`context_files` 배열을 worker spec에 그대로 사용한다. 기본 파일당 500KB, 전체 2MB,
Git diff 200KB 제한이며 `.env`, 개인 키, 알려진 API 키 형식과 지원하지 않는 바이너리는
본문에 넣지 않는다. Git diff에도 같은 include/exclude를 적용한다. 바이너리는
`allow_binary_attachments`에 검토한 상대 경로를 정확히 적은 파일만 첨부한다.

## Browser Bridge 파일 왕복

기존 웹 대화에서 파일을 올리거나 결과를 내려받을 때, 또는 기존 이벤트 로그 작업을
복구할 때 사용한다. Chrome에서 Browser Bridge가 연결된 상태라면 프로젝트 루트에서
다음 명령을 사용한다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run_browser_loop.ps1 `
  -RunDir runs/my-task-001 `
  -Spec specs/command-loop-canary.json
```

실행기는 다음 작업을 자동으로 처리한다.

- 서버와 Chrome 확장 연결 상태를 검사한다.
- 실행 폴더가 없으면 작업 명세로 `context.zip`을 준비한다.
- 새 ChatGPT 탭을 열고 프롬프트와 컨텍스트를 첨부한다.
- 지정한 이름의 결과만 다운로드해 안전하게 압축 해제한다.
- 로컬 검증 실패 시 `feedback.zip`을 같은 대화에 제출한다.
- 통과·동일 실패 반복·최대 시도 도달까지 상태 머신을 진행한다.
- 전송 전에 제출 키와 DOM 결과 기준값을 저널에 남긴다.
- 중간에 종료되면 같은 명령을 다시 실행해 중복 전송 없이 기록된 대화를 이어간다.
- 사용자가 지정한 탭이 정확한 `chatgpt.com` 탭이 아니면 제출 전에 중단한다.
- 파일 버튼이 서명 URL로 탭을 이동시키는 경우 브라우저 세션으로 직접 저장하고
  원래 대화로 돌아간다.

실행 결과는 `runs/my-task-001/state.json`과
`browser-automation-report.json`에서 확인한다. 새 업무는
`specs/command-loop-canary.json`을 복사해 프롬프트, 컨텍스트 파일, 결과 계약,
로컬 검증 명령만 교체한다.

## 최대 3개 Browser Bridge 작업자 오케스트레이션

`src/orchestrator.mjs`는 기존 단일 브라우저 루프를 변경하지 않고 최대 3개의
ChatGPT 작업자를 capability와 프로젝트 경계에 맞춰 임대한다. 하나의 coordinator
프로세스가 `orchestrator-events.jsonl`을 소유하며, 재시작하면 이 append-only 로그를
재생해 작업자·작업 상태를 복구한다.

```javascript
import { registerWorker, runOperations } from "./src/orchestrator.mjs";

const stateDir = "runs/orchestrator";
for (const [workerId, tabId] of [["research-a", 101], ["research-b", 102], ["research-c", 103]]) {
  registerWorker(stateDir, {
    workerId,
    tabId,
    projectUrl: "https://chatgpt.com/g/g-p-example/project",
    capabilities: ["research"],
  });
}

await runOperations({
  stateDir,
  jobs: ["runs/a", "runs/b", "runs/c"].map((runDir, index) => ({
    runDir,
    workerId: `research-${"abc"[index]}`,
    requiredCapabilities: ["research"],
  })),
});
```

각 `runDir`은 기존 `harness.py prepare`로 먼저 준비하고, 작업 명세의
`project_url`은 등록한 작업자의 프로젝트와 같아야 한다. 작업 상태는
`CREATED → LEASED → RUNNING → COMPLETED | FAILED`로 기록된다. 내부 ZIP 검증과
feedback 반복은 기존 하네스가 계속 담당한다. 완료된 작업을 다시 호출하면 브라우저에
중복 제출하지 않고 기록된 완료 상태를 반환한다. 같은 worker의 다음 작업은 저장된
conversation URL을 새 `prepared` 실행에 연결하므로 프로젝트 대화를 계속 사용한다.
실행 중 대화를 만든 뒤 실패해도 확인된 conversation URL은 작업자에 보존한다.
동일 operation의 프로세스 내 동시 실행은 거부한다.
세 작업자는 같은 계정 제한을 공유하므로 제출 시작은 기본 60초 간격으로 분산한다.
첫 `rate_limit` 뒤 아직 시작하지 않은 작업은 제출하지 않으며, 이벤트 로그에 15분
냉각 시간을 기록해 프로세스를 다시 시작해도 즉시 재시도하지 않는다.

현재 자동 테스트는 3개 동시 임대·완료와 실패 후 작업자 해제를 검증한다. 실제 Chrome
3개 탭 병렬 카나리는 프로젝트 홈 탭 ID를 지정한 뒤 별도로 수행한다.

실사용은 작업자와 작업 명세 경로를 JSON manifest에 선언한 뒤 한 명령으로 실행한다.
CLI는 누락된 `runDir`을 준비하고 브리지를 시작하며 라이브 제출 간격 60초 미만을
거부한다. 모든 상대 경로는 manifest 파일 위치를 기준으로 해석한다. 최소 manifest는
다음과 같고 같은 형식의 worker/job 쌍을 최대 3개까지 둔다.

```json
{
  "schema_version": 1,
  "state_dir": "../../runs/my-task/orchestrator",
  "workers": [
    {"worker_id": "research-a", "tab_id": 101, "project_url": "https://chatgpt.com/g/g-p-12345678901234567890123456789012/project", "capabilities": ["research"]}
  ],
  "jobs": [
    {"run_dir": "../../runs/my-task/a", "spec": "worker-a.json", "worker_id": "research-a", "required_capabilities": ["research"]}
  ]
}
```

```powershell
node src/orchestrator_cli.mjs --manifest plans/my-task/manifest.json
```

리서치 작업의 기본 ZIP 계약은 `report.md`와 `sources.md` 두 파일이다.
`verifiers/markdown_research.py`는 두 파일의 존재, Markdown HTTP(S) 링크, 본문 인용과
출처 목록의 일치를 검사한다. 이는 구조 검증이며 출처 내용의 진위 확인과 최종 종합은
Codex가 로컬에서 수행한다.

2026-09-03 실브라우저 카나리에서 ChatGPT가 프로젝트 대화 URL의 프로젝트 ID 뒤에
이름 slug를 붙이는 실제 형식을 확인해 반영했다. 다른 프로젝트 prefix는 계속 차단한다.
3개 재실행은 ChatGPT의 "요청이 너무 많습니다" 계정 제한으로 안전 중단했으며, 이제
이 안내와 확인 버튼이 함께 있는 제한 UI만 `rate_limit`으로 감지해 일반 대화의 같은
문구를 오인하지 않는다. 계정 제한 해제는 확인했지만 추가 부하 시험은 사용자 결정으로
생략한다. 운영 상한은 3개 worker이며 60초 제출 분산과 15분 회로차단을 유지한다.

## 상태 머신 수동 실행

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
