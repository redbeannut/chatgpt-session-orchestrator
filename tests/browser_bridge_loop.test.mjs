// Browser Bridge 자동 실행기의 순수 선택·파일명 로직을 검증한다.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNoBlockingNotice,
  clickAndCaptureDownload,
  conversationBelongsToProject,
  expectedDownloadRegex,
  findConversationTab,
  isCanonicalConversationUrl,
  isChatGptDownloadUrl,
  isChatGptSurfaceUrl,
  isExpectedDownload,
  normalizeConversationUrl,
  normalizeProjectUrl,
  parseArgs,
  recoverPendingSubmission,
  resultElements,
  resumeAutomationReport,
  selectComposer,
  selectPreferredTab,
  selectSendButton,
  submitAction,
  uploadFile,
  validatePendingDownload,
} from "../src/browser_bridge_loop.mjs";

test("ChatGPT 요청 제한 안내는 즉시 rate_limit으로 중단한다", () => {
  const quotedNotice = {
    elements: [{ role: "textbox", label: "요청이 너무 많습니다", tag: "textarea" }],
  };
  assert.doesNotThrow(() => assertNoBlockingNotice(quotedNotice, "요청이 너무 많습니다"));
  for (const renderedText of ["요청이 너무 많습니다", "Too many requests"]) {
    assert.throws(
      () => assertNoBlockingNotice(
        { elements: [{ tag: "button", label: "알겠습니다" }] },
        renderedText,
      ),
      (error) => error.code === "rate_limit" && /자동 재시도.*중단/.test(error.message),
    );
  }
});

test("보류 제출 복구에서도 요청 제한을 rate_limit으로 분류한다", async () => {
  const conversationUrl = "https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39";
  const client = {
    async callTool({ name }) {
      if (name === "tabs_list") return mcpResult([{ id: 43, url: conversationUrl }]);
      if (name === "snapshot") {
        return mcpResult({ elements: [{ tag: "button", label: "알겠습니다", ref: 7 }] });
      }
      if (name === "get_page_text") {
        return mcpResult({
          url: conversationUrl,
          text: "요청이 너무 많습니다\n요청을 너무 빠르게 보내고 있습니다.",
        });
      }
      throw new Error(`예상하지 못한 도구 호출: ${name}`);
    },
  };
  await assert.rejects(
    recoverPendingSubmission(
      client,
      {
        submission_key: "operation:initial:0",
        conversation_url: conversationUrl,
        project_url: null,
        expected_download: "result.zip",
        attachments: [],
      },
      { submission_key: "operation:initial:0", tab_id: 43, baseline_results: 0 },
      Date.now() + 1000,
      "unused",
    ),
    (error) => error.code === "rate_limit",
  );
});

function mcpResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

test("Chrome 중복 다운로드 파일명을 정확히 허용한다", () => {
  const regex = expectedDownloadRegex("result.zip");
  assert.match("result.zip", regex);
  assert.match("result (1).zip", regex);
  assert.match("result(23).zip", regex);
  assert.match("result(20260903-053234).zip", regex);
  assert.doesNotMatch("result(latest).zip", regex);
  assert.equal(isExpectedDownload("other-result.zip", "result.zip"), false);
  assert.equal(isExpectedDownload("result.zip.crdownload", "result.zip"), false);
});

test("임시 WEB 대화 URL을 거부하고 정식 URL을 정규화한다", () => {
  assert.equal(isCanonicalConversationUrl("https://chatgpt.com/c/WEB:temporary"), false);
  assert.equal(isCanonicalConversationUrl("https://chatgpt.com/c/WEB%3Atemporary"), false);
  assert.equal(isCanonicalConversationUrl("https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39/extra"), false);
  assert.equal(isCanonicalConversationUrl("https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39"), true);
  assert.equal(
    normalizeConversationUrl("https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39?x=1#main"),
    "https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39",
  );
  assert.equal(isChatGptSurfaceUrl("https://chatgpt.com/"), true);
  assert.equal(isChatGptSurfaceUrl("https://example.com/"), false);
  assert.equal(
    isChatGptDownloadUrl("https://chatgpt.com/backend-api/estuary/content?id=file_123"),
    true,
  );
  assert.equal(isChatGptDownloadUrl("https://chatgpt.com/c/file_123"), false);
});

test("사용자가 지정한 탭은 ChatGPT 표면일 때만 선택한다", () => {
  const tabs = [
    { id: 1, url: "https://example.com/" },
    { id: 2, url: "https://chatgpt.com/" },
  ];
  assert.throws(() => selectPreferredTab(tabs, 1, null), /ChatGPT 탭이 아닙니다/);
  assert.throws(() => selectPreferredTab(tabs, 3, null), /찾지 못했습니다/);
  assert.equal(selectPreferredTab(tabs, 2, null).id, 2);
  assert.equal(
    selectPreferredTab(tabs, 1, "https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39"),
    null,
  );
});

test("프로젝트 홈과 그 프로젝트의 대화만 허용한다", () => {
  const projectUrl = "https://chatgpt.com/g/g-p-browser-loop-test/project";
  const conversationUrl = "https://chatgpt.com/g/g-p-browser-loop-test/c/6a98d663-fa60-83e8-9470-dd4056981f39";
  assert.equal(normalizeProjectUrl(`${projectUrl}?view=all#main`), projectUrl);
  assert.equal(normalizeProjectUrl("https://chatgpt.com/g/g-custom"), null);
  assert.equal(normalizeProjectUrl("https://USER@chatgpt.com/g/g-p-browser-loop-test/project"), null);
  assert.equal(normalizeProjectUrl("https://chatgpt.com/g//g-p-browser-loop-test/project"), null);
  assert.equal(normalizeProjectUrl("https://chatgpt.com/g/g-p-browser-loop-test/project//"), null);
  assert.equal(conversationBelongsToProject(conversationUrl, projectUrl), true);
  const liveProjectUrl = "https://chatgpt.com/g/g-p-6a991e8091dc819195e06f600822bd05/project";
  assert.equal(conversationBelongsToProject(
    "https://chatgpt.com/g/g-p-6a991e8091dc819195e06f600822bd05-codex-browser-canary/c/6a98d663-fa60-83e8-9470-dd4056981f39",
    liveProjectUrl,
  ), true);
  assert.equal(conversationBelongsToProject(
    "https://chatgpt.com/g/g-p-6a991e8091dc819195e06f600822bd050-other/c/6a98d663-fa60-83e8-9470-dd4056981f39",
    liveProjectUrl,
  ), false);
  assert.equal(conversationBelongsToProject(
    "https://chatgpt.com/g/g-p-other/c/6a98d663-fa60-83e8-9470-dd4056981f39",
    projectUrl,
  ), false);

  const tabs = [
    { id: 2, url: "https://chatgpt.com/" },
    { id: 3, url: projectUrl },
  ];
  assert.throws(() => selectPreferredTab(tabs, 2, null, projectUrl), /프로젝트 홈이 아닙니다/);
  assert.equal(selectPreferredTab(tabs, 3, null, projectUrl).id, 3);
});

test("새 작업 탭은 명시한 프로젝트 홈에서 연다", async () => {
  const projectUrl = "https://chatgpt.com/g/g-p-browser-loop-test/project";
  const calls = [];
  let openedUrl = null;
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === "tabs_list") {
        return mcpResult(openedUrl ? [{ id: 41, url: openedUrl }] : []);
      }
      if (request.name === "tab_new") {
        openedUrl = request.arguments.url;
        return mcpResult({ id: 41, url: openedUrl });
      }
      throw new Error(`예상하지 못한 도구 호출: ${request.name}`);
    },
  };
  const tab = await findConversationTab(client, null, null, projectUrl);
  assert.deepEqual(tab, { id: 41, url: projectUrl });
  assert.equal(calls.find((call) => call.name === "tab_new").arguments.url, projectUrl);
});

test("프로젝트 탭이 홈으로 리디렉션되면 신규·재개 전송을 차단한다", async () => {
  const projectUrl = "https://chatgpt.com/g/g-p-browser-loop-test/project";
  const conversationUrl = "https://chatgpt.com/g/g-p-browser-loop-test/c/6a98d663-fa60-83e8-9470-dd4056981f39";
  for (const savedConversation of [null, conversationUrl]) {
    let opened = false;
    const calls = [];
    const client = {
      async callTool(request) {
        calls.push(request);
        if (request.name === "tabs_list") {
          return mcpResult(opened ? [{ id: 42, url: "https://chatgpt.com/" }] : []);
        }
        if (request.name === "tab_new") {
          opened = true;
          return mcpResult({ id: 42, url: request.arguments.url });
        }
        throw new Error(`예상하지 못한 도구 호출: ${request.name}`);
      },
    };
    await assert.rejects(
      findConversationTab(client, savedConversation, null, projectUrl),
      /프로젝트 범위가 아닙니다/,
    );
    assert.equal(calls.some((call) => ["fill", "file_upload", "click"].includes(call.name)), false);
  }
});

test("탭이 전송 직전에 범위를 벗어나면 신규·보류 제출 모두 무동작으로 끝난다", async () => {
  const projectUrl = "https://chatgpt.com/g/g-p-browser-loop-test/project";
  const action = {
    action: "submit_initial",
    submission_key: "operation:initial:0",
    conversation_url: null,
    project_url: projectUrl,
    expected_download: "result.zip",
    attachments: [],
    prompt: "test",
  };
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === "tabs_list") return mcpResult([{ id: 43, url: "https://chatgpt.com/" }]);
      throw new Error(`범위 확인 뒤 호출되면 안 되는 도구: ${request.name}`);
    },
  };
  await assert.rejects(
    submitAction(client, { id: 43 }, action, Date.now() + 1000, "unused", 0),
    /프로젝트 범위가 아닙니다/,
  );
  await assert.rejects(
    recoverPendingSubmission(
      client,
      action,
      { submission_key: action.submission_key, tab_id: 43 },
      Date.now() + 1000,
      "unused",
    ),
    /프로젝트 범위가 아닙니다/,
  );
  assert.equal(calls.some((call) => ["fill", "file_upload", "click"].includes(call.name)), false);
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

test("가시 입력창과 숨겨진 파일 입력의 마지막·첫 요소를 고른다", () => {
  const selected = selectComposer({ elements: [
    { role: "textbox", inViewport: false, ref: 1 },
    { role: "textbox", inViewport: true, ref: 2 },
    { role: "textbox", inViewport: true, ref: 3 },
    { tag: "input", type: "file", inViewport: false, ref: 4 },
    { tag: "input", type: "file", inViewport: true, ref: 5 },
  ] });
  assert.equal(selected.textbox.ref, 3);
  assert.equal(selected.fileInput.ref, 4);
});

test("파일 입력이 여러 개면 일반 첨부용 입력을 고른다", () => {
  const selected = selectComposer({ elements: [
    { role: "textbox", inViewport: true, ref: 3 },
    { tag: "input", type: "file", id: "upload-photos", ref: 4 },
    { tag: "input", type: "file", attributes: { id: "upload-files" }, ref: 5 },
  ] });
  assert.equal(selected.fileInput.ref, 5);
});

test("스냅샷에 파일 입력이 없으면 일반 파일용 CSS 선택자로 복구한다", async () => {
  const selected = selectComposer({ elements: [
    { role: "textbox", inViewport: true, ref: 3 },
  ] });
  assert.equal(selected.fileInput, null);

  const directory = mkdtempSync(path.join(tmpdir(), "browser-loop-upload-"));
  const filePath = path.join(directory, "context.zip");
  writeFileSync(filePath, "zip");
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      return mcpResult({ uploaded: "context.zip" });
    },
  };
  try {
    await uploadFile(client, 17, selected.fileInput?.ref, filePath);
    assert.equal(calls[0].name, "file_upload");
    assert.equal(calls[0].arguments.selector, "#upload-files");
    assert.equal(calls[0].arguments.mimeType, "application/zip");
    assert.equal("ref" in calls[0].arguments, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("작은 텍스트 파일은 text/plain으로 업로드한다", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "browser-loop-text-upload-"));
  const filePath = path.join(directory, "fish.txt");
  writeFileSync(filePath, "sample");
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      return mcpResult({ uploaded: "fish.txt" });
    },
  };
  try {
    await uploadFile(client, 17, 9, filePath);
    assert.equal(calls[0].arguments.ref, 9);
    assert.equal(calls[0].arguments.mimeType, "text/plain");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("빈 파일은 브라우저 도구를 호출하기 전에 거부한다", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "browser-loop-empty-upload-"));
  const filePath = path.join(directory, "empty.txt");
  writeFileSync(filePath, "");
  let called = false;
  const client = {
    async callTool() {
      called = true;
      return mcpResult({});
    },
  };
  try {
    await assert.rejects(uploadFile(client, 17, null, filePath), /빈 파일/);
    assert.equal(called, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test("다운로드 기준은 제출 키와 실제 DOM 기준 개수를 재시작 뒤에도 보존한다", () => {
  const url = "https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39";
  const pending = {
    submission_key: "feedback-002",
    conversation_url: url,
    expected_download: "result.zip",
    baseline_results: 4,
  };
  const action = { expected_download: "result.zip" };
  const state = {
    conversation_url: `${url}?temporary=1`,
    submissions: [{ submission_key: "initial-001" }, { submission_key: "feedback-002" }],
    attempts: [{ attempt: 1 }],
  };
  assert.equal(validatePendingDownload(pending, action, state), 4);
  assert.throws(
    () => validatePendingDownload({ ...pending, submission_key: "initial-001" }, action, state),
    /제출 키/,
  );
  assert.throws(() => validatePendingDownload(null, action, state), /이전 결과물 선택을 차단/);
});

test("파일 클릭이 서명 URL로 이동하면 직접 저장하고 원래 대화로 복귀한다", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "browser-loop-download-"));
  const conversationUrl = "https://chatgpt.com/c/6a98d663-fa60-83e8-9470-dd4056981f39";
  const downloadUrl = "https://chatgpt.com/backend-api/estuary/content?id=file_123";
  let currentUrl = conversationUrl;
  const calls = [];
  const client = {
    async callTool({ name, arguments: args }) {
      calls.push(name);
      if (name === "tabs_list") return mcpResult([{ id: 7, url: currentUrl }]);
      if (name === "click") {
        currentUrl = downloadUrl;
        return mcpResult({ via: "synthetic" });
      }
      if (name === "download_resource") {
        writeFileSync(args.savePath, Buffer.from("zip-bytes"));
        return mcpResult({ savedTo: args.savePath });
      }
      if (name === "navigate") {
        currentUrl = args.url;
        return mcpResult({ tabId: 7, url: currentUrl });
      }
      throw new Error(`예상하지 못한 도구 호출: ${name}`);
    },
  };
  try {
    const downloaded = await clickAndCaptureDownload(
      client,
      7,
      { ref: 11 },
      "result.zip",
      directory,
      Date.now() + 10_000,
    );
    assert.equal(downloaded.method, "bridge-download-resource");
    assert.equal(downloaded.conversationRestored, true);
    assert.equal(readFileSync(downloaded.path, "utf8"), "zip-bytes");
    assert.equal(currentUrl, conversationUrl);
    assert.deepEqual(
      calls,
      ["tabs_list", "click", "tabs_list", "download_resource", "navigate", "tabs_list"],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function pathJoin(...parts) {
  return parts.join(process.platform === "win32" ? "\\" : "/");
}
