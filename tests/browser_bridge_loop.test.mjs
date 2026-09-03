// Browser Bridge 자동 실행기의 순수 선택·파일명 로직을 검증한다.
import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedDownloadRegex,
  isCanonicalConversationUrl,
  isExpectedDownload,
  normalizeConversationUrl,
  parseArgs,
  resultElements,
  resumeAutomationReport,
  selectComposer,
  selectSendButton,
} from "../src/browser_bridge_loop.mjs";

test("Chrome 중복 다운로드 파일명을 정확히 허용한다", () => {
  const regex = expectedDownloadRegex("result.zip");
  assert.match("result.zip", regex);
  assert.match("result (1).zip", regex);
  assert.match("result(23).zip", regex);
  assert.equal(isExpectedDownload("other-result.zip", "result.zip"), false);
  assert.equal(isExpectedDownload("result.zip.crdownload", "result.zip"), false);
});

test("임시 WEB 대화 URL을 거부하고 정식 URL을 정규화한다", () => {
  assert.equal(isCanonicalConversationUrl("https://chatgpt.com/c/WEB:temporary"), false);
  assert.equal(isCanonicalConversationUrl("https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39"), true);
  assert.equal(
    normalizeConversationUrl("https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39?x=1#main"),
    "https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39",
  );
});

test("결과 버튼은 기대 파일명이 포함된 링크나 버튼만 고른다", () => {
  const matches = resultElements({ elements: [
    { tag: "button", label: "result.zip 다운로드", ref: 1 },
    { tag: "a", label: "Download result.zip", ref: 2 },
    { tag: "button", label: "image.png 다운로드", ref: 3 },
    { tag: "div", label: "result.zip", ref: 4 },
  ] }, "result.zip");
  assert.deepEqual(matches.map((item) => item.ref), [1, 2]);
});

test("가시 입력창과 파일 입력의 마지막·첫 요소를 고른다", () => {
  const selected = selectComposer({ elements: [
    { role: "textbox", inViewport: false, ref: 1 },
    { role: "textbox", inViewport: true, ref: 2 },
    { role: "textbox", inViewport: true, ref: 3 },
    { tag: "input", type: "file", inViewport: true, ref: 4 },
    { tag: "input", type: "file", inViewport: true, ref: 5 },
  ] });
  assert.equal(selected.textbox.ref, 3);
  assert.equal(selected.fileInput.ref, 4);
});

test("한국어와 영어의 활성 전송 버튼을 인식한다", () => {
  assert.equal(selectSendButton({ elements: [
    { tag: "button", label: "프롬프트 보내기", enabled: false, ref: 1 },
    { tag: "button", label: "Send prompt", enabled: true, ref: 2 },
  ] }).ref, 2);
});

test("실행 인수를 검증하고 절대 경로로 바꾼다", () => {
  const options = parseArgs(["--run-dir", "runs/test", "--timeout-seconds", "90"]);
  assert.equal(options.runDir.endsWith(pathJoin("runs", "test")), true);
  assert.equal(options.timeoutSeconds, 90);
  assert.throws(() => parseArgs(["--run-dir", "runs/test", "--timeout-seconds", "5"]));
});

test("재실행 보고서는 기존 이벤트를 보존한다", () => {
  const resumed = resumeAutomationReport({
    schema_version: 1,
    started_at: "first",
    events: [{ action: "verify", status: "pass" }],
    finished_at: "finished",
    final_status: "verified",
  }, "second");
  assert.deepEqual(resumed.events, [{ action: "verify", status: "pass" }]);
  assert.equal(resumed.sessions.at(-1).started_at, "second");
  assert.equal(resumed.previous_runs.at(-1).final_status, "verified");
  assert.equal("final_status" in resumed, false);
});

function pathJoin(...parts) {
  return parts.join(process.platform === "win32" ? "\\" : "/");
}
