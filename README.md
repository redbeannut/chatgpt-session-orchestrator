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

