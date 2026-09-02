# ChatGPT Browser Loop PoC

Codex가 로그인된 Chrome의 ChatGPT 대화를 조작하고, 생성된 ZIP을 로컬에서
검증한 뒤 실패 결과를 같은 대화로 돌려보내는 최소 수직 슬라이스다.

관련 노트는 [[../0. 하네스 엔지니어링 백과사전]]이다.

## 범위

1. `context.zip`과 최초 요청문을 생성한다.
2. Codex가 Chrome의 새 ChatGPT 대화에 둘을 제출한다.
3. 첫 `result.zip`은 의도적으로 실패해야 한다.
4. 로컬 검증기가 `feedback.zip`을 만든다.
5. 같은 ChatGPT 대화에 피드백을 제출한다.
6. 두 번째 `result.zip`이 로컬 검증을 통과해야 한다.

브라우저 전송은 현재 Codex Chrome 브리지로 검증한다. 상태와 ZIP 계약은
브리지에 종속되지 않으므로 이후 `browser-bridge` 전송 어댑터를 붙일 수 있다.

## 실측 결과

2026-09-02에 로그인된 Chrome의 독립 ChatGPT 대화에서 `live-001`을 실행했다.

| 단계 | 결과 | 증거 |
| --- | --- | --- |
| 첫 결과 다운로드 | 성공 | SHA-256 `050dde37245a5a4ef2c29641ca9602d1583e49e1f0885d4f942448e48d8bb4a3` |
| 첫 로컬 검증 | 의도대로 실패 | 종료 코드 `2`, 실제 값 `BROKEN: first transport canary\n` |
| 같은 대화 피드백 | 성공 | 동일 대화 URL에서 실패 지문과 기대값 전달 |
| 수정 결과 다운로드 | 성공 | SHA-256 `956ae3727f55cfaee9e14ceda1188d17cec9a6fadfc08def317580285887a515` |
| 두 번째 로컬 검증 | 통과 | 종료 코드 `0`, 상태 `verified` |

현재 Codex Chrome 브리지는 다운로드와 동일 대화 후속 요청을 처리했지만,
프로그램 방식 파일 선택은 Vault 경로와 로컬 다운로드 경로 모두 `Not allowed`로
거부했다. 그래서 이번 실행의 `context.zip`과 `feedback.zip` 내용은 본문에
인라인으로 전달했다. 상태 머신·안전한 ZIP 검증·실패 후 재시도는 실증됐지만,
무인 파일 업로드는 아직 통과하지 않았다.

다음 단계는 현재 상태 머신을 유지한 채 `browser-bridge` 또는
`codex-chatgpt-control` 방식의 파일 전송 어댑터를 연결하고, 같은 계약으로
업로드까지 다시 검증하는 것이다. 그 뒤 HWPX 구조·렌더링 검증기를 추가한다.

## 실행

```powershell
python src/harness.py prepare --run-dir runs/poc-001
python src/harness.py record-session --run-dir runs/poc-001 --url "https://chatgpt.com/c/..."
python src/harness.py verify --run-dir runs/poc-001 --result-zip runs/poc-001/downloads/result.zip
python src/harness.py status --run-dir runs/poc-001
```

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
