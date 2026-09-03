// Browser Bridge를 통해 ChatGPT 파일 왕복과 로컬 검증을 자동 반복한다.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(MODULE_PATH), "..");
const DEFAULT_BRIDGE_ROOT = path.join(homedir(), "tools", "browser-bridge");
const DEFAULT_DOWNLOAD_DIR = path.join(homedir(), "Downloads");
const BASE64_UPLOAD_LIMIT = 4 * 1024 * 1024;
const PENDING_SUBMISSION_FILE = "pending-submission.json";
const PENDING_DOWNLOAD_FILE = "pending-download.json";

export function parseArgs(argv) {
  const options = {
    runDir: null,
    tabId: null,
    timeoutSeconds: 300,
    bridgeRoot: process.env.BROWSER_BRIDGE_ROOT || DEFAULT_BRIDGE_ROOT,
    downloadDir: process.env.BROWSER_DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--run-dir" && value) {
      options.runDir = path.resolve(value);
      index += 1;
    } else if (arg === "--tab-id" && value) {
      options.tabId = Number(value);
      index += 1;
    } else if (arg === "--timeout-seconds" && value) {
      options.timeoutSeconds = Number(value);
      index += 1;
    } else if (arg === "--bridge-root" && value) {
      options.bridgeRoot = path.resolve(value);
      index += 1;
    } else if (arg === "--download-dir" && value) {
      options.downloadDir = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`알 수 없는 인수입니다: ${arg}`);
    }
  }
  if (!options.runDir) throw new Error("--run-dir가 필요합니다.");
  if (options.tabId !== null && (!Number.isInteger(options.tabId) || options.tabId <= 0)) {
    throw new Error("--tab-id는 양의 정수여야 합니다.");
  }
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 30) {
    throw new Error("--timeout-seconds는 30 이상이어야 합니다.");
  }
  return options;
}

export function expectedDownloadRegex(filename) {
  const parsed = path.parse(filename);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escape(parsed.name)}(?:\\s*\\((?:\\d+|\\d{8}-\\d{6})\\))?${escape(parsed.ext)}$`,
    "i",
  );
}

export function isExpectedDownload(filename, expected) {
  return expectedDownloadRegex(expected).test(filename) && !filename.endsWith(".crdownload");
}

function strictChatGptUrl(rawUrl) {
  if (!rawUrl) return null;
  const raw = String(rawUrl).trim();
  if (!raw.startsWith("https://chatgpt.com/")) return null;
  try {
    const url = new URL(raw);
    return !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}

export function normalizeConversationUrl(rawUrl) {
  try {
    const url = strictChatGptUrl(rawUrl);
    if (!url) return null;
    const decodedPath = decodeURIComponent(url.pathname).replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    url.pathname = decodedPath;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function isCanonicalConversationUrl(rawUrl) {
  const normalized = normalizeConversationUrl(rawUrl);
  if (!normalized) return false;
  const url = new URL(normalized);
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  return new RegExp(`^/c/${uuid}$`, "i").test(url.pathname)
    || new RegExp(`^/g/[^/]+/c/${uuid}$`, "i").test(url.pathname);
}

export function normalizeProjectUrl(rawUrl) {
  try {
    const url = strictChatGptUrl(rawUrl);
    if (!url) return null;
    const decodedPath = decodeURIComponent(url.pathname).replace(/\/$/, "");
    if (!/^\/g\/[A-Za-z0-9_-]+\/project$/.test(decodedPath)) return null;
    url.search = "";
    url.hash = "";
    url.pathname = decodedPath;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function conversationBelongsToProject(conversationUrl, projectUrl) {
  const conversation = normalizeConversationUrl(conversationUrl);
  const project = normalizeProjectUrl(projectUrl);
  if (!conversation || !project || !isCanonicalConversationUrl(conversation)) return false;
  const conversationParts = new URL(conversation).pathname.split("/");
  const projectParts = new URL(project).pathname.split("/");
  return conversationParts.length === 5
    && conversationParts[1] === "g"
    && conversationParts[2] === projectParts[2];
}

export function isChatGptSurfaceUrl(rawUrl) {
  return strictChatGptUrl(rawUrl) !== null;
}

export function isChatGptDownloadUrl(rawUrl) {
  try {
    const url = strictChatGptUrl(rawUrl);
    return Boolean(url?.pathname.startsWith("/backend-api/estuary/content"));
  } catch {
    return false;
  }
}

export function tabMatchesActionScope(tabUrl, conversationUrl, projectUrl, allowProjectConversation = false) {
  if (conversationUrl) {
    return normalizeConversationUrl(tabUrl) === normalizeConversationUrl(conversationUrl)
      && (!projectUrl || conversationBelongsToProject(tabUrl, projectUrl));
  }
  if (projectUrl) {
    return normalizeProjectUrl(tabUrl) === normalizeProjectUrl(projectUrl)
      || (allowProjectConversation && conversationBelongsToProject(tabUrl, projectUrl));
  }
  return isChatGptSurfaceUrl(tabUrl);
}

export function selectPreferredTab(tabs, preferredTabId, conversationUrl, projectUrl = null) {
  if (preferredTabId === null) return null;
  const preferred = tabs.find((tab) => tab.id === preferredTabId);
  if (!preferred && !conversationUrl) {
    throw new Error(`지정한 Chrome 탭을 찾지 못했습니다: ${preferredTabId}`);
  }
  if (preferred && !isChatGptSurfaceUrl(preferred.url) && !conversationUrl) {
    throw new Error(`지정한 탭은 ChatGPT 탭이 아닙니다: ${preferred.url}`);
  }
  const normalizedProject = normalizeProjectUrl(projectUrl);
  if (projectUrl && !normalizedProject) {
    throw new Error(`ChatGPT 프로젝트 홈 URL이 올바르지 않습니다: ${projectUrl}`);
  }
  if (preferred && !conversationUrl && normalizedProject
      && normalizeProjectUrl(preferred.url) !== normalizedProject) {
    throw new Error(`지정한 탭은 요청한 ChatGPT 프로젝트 홈이 아닙니다: ${preferred.url}`);
  }
  const normalizedConversation = normalizeConversationUrl(conversationUrl);
  if (preferred && (!conversationUrl
      || normalizeConversationUrl(preferred.url) === normalizedConversation)) {
    return preferred;
  }
  return null;
}

export function resultElements(snapshot, expectedFilename) {
  const target = expectedFilename.toLocaleLowerCase();
  return (snapshot.elements || []).filter((element) => {
    const label = String(element.label || "").toLocaleLowerCase();
    return ["button", "a"].includes(element.tag) && label.includes(target);
  });
}

export function selectComposer(snapshot) {
  const elements = snapshot.elements || [];
  const textboxes = elements.filter(
    (element) => element.role === "textbox" && element.inViewport !== false,
  );
  const fileInputs = elements.filter(
    (element) => element.tag === "input" && element.type === "file",
  );
  if (!textboxes.length) throw new Error("ChatGPT 입력창을 찾지 못했습니다.");
  return { textbox: textboxes.at(-1), fileInput: fileInputs[0] || null };
}

export function selectSendButton(snapshot) {
  const labels = ["프롬프트 보내기", "메시지 보내기", "send prompt", "send message"];
  return (snapshot.elements || []).find((element) => {
    const label = String(element.label || "").toLocaleLowerCase();
    return element.tag === "button" && element.inViewport !== false
      && element.enabled !== false && labels.some((item) => label.includes(item));
  });
}

export function resumeAutomationReport(existing, startedAt) {
  if (!existing) {
    return {
      schema_version: 1,
      started_at: startedAt,
      sessions: [{ started_at: startedAt }],
      events: [],
    };
  }
  const report = structuredClone(existing);
  report.sessions = Array.isArray(report.sessions) ? report.sessions : [];
  report.sessions.push({ started_at: startedAt });
  report.events = Array.isArray(report.events) ? report.events : [];
  if (report.finished_at || report.final_status) {
    report.previous_runs = Array.isArray(report.previous_runs) ? report.previous_runs : [];
    report.previous_runs.push({
      finished_at: report.finished_at || null,
      final_status: report.final_status || null,
      error: report.error || null,
    });
  }
  delete report.finished_at;
  delete report.final_status;
  delete report.error;
  return report;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removeIfExists(filePath) {
  if (existsSync(filePath)) unlinkSync(filePath);
}

function parseTextResult(result, toolName) {
  const text = (result.content || [])
    .filter((item) => item.type === "text")
    .map((item) => item.text || "")
    .join("\n")
    .trim();
  if (result.isError) throw new Error(`${toolName} 실패: ${text}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return parseTextResult(result, name);
}

function runHarness(args, allowedExitCodes = [0]) {
  const python = process.env.PYTHON || "python";
  const completed = spawnSync(
    python,
    [path.join(PROJECT_ROOT, "src", "harness.py"), ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: { ...process.env, PYTHONUTF8: "1" },
    },
  );
  if (!allowedExitCodes.includes(completed.status)) {
    throw new Error(
      `하네스 명령 실패 (${completed.status}): ${completed.error?.message || completed.stderr || completed.stdout}`,
    );
  }
  const output = (completed.stdout || "").trim();
  return output ? JSON.parse(output) : null;
}

function readState(runDir) {
  return JSON.parse(readFileSync(path.join(runDir, "state.json"), "utf8"));
}

async function connectBridge(bridgeRoot) {
  const sdkRoot = path.join(bridgeRoot, "server", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  const clientModule = await import(pathToFileURL(path.join(sdkRoot, "client", "index.js")).href);
  const transportModule = await import(pathToFileURL(path.join(sdkRoot, "client", "streamableHttp.js")).href);
  const tokenPath = path.join(homedir(), ".browser-bridge", "token");
  const token = readFileSync(tokenPath, "utf8").trim();
  const client = new clientModule.Client(
    { name: "chatgpt-browser-loop", version: "0.4.0" },
    { capabilities: {} },
  );
  const transport = new transportModule.StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:8765/mcp"),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

async function doctor(client) {
  const response = await fetch("http://127.0.0.1:8765/health");
  if (!response.ok) throw new Error(`Browser Bridge health 실패: HTTP ${response.status}`);
  const health = await response.json();
  if (!health.ok || !health.extensionConnected) {
    throw new Error("Browser Bridge Chrome 확장이 연결되지 않았습니다.");
  }
  const status = await callTool(client, "bridge_status", {});
  const tabs = await callTool(client, "tabs_list", { short: false });
  const loggedIn = tabs.some((tab) => String(tab.url || "").startsWith("https://chatgpt.com/"));
  if (!loggedIn) throw new Error("로그인된 ChatGPT Chrome 탭이 없습니다.");
  return { health, status, chatgptTabs: tabs.filter((tab) => String(tab.url || "").startsWith("https://chatgpt.com/")) };
}

async function snapshot(client, tabId) {
  return callTool(client, "snapshot", { tabId });
}

async function currentTab(client, tabId) {
  const tabs = await callTool(client, "tabs_list", { short: false });
  return tabs.find((tab) => tab.id === tabId) || null;
}

export async function assertActionTabScope(client, tabId, action, allowProjectConversation = false) {
  const tab = await currentTab(client, tabId);
  if (!tab || !tabMatchesActionScope(
    tab.url,
    action.conversation_url,
    action.project_url,
    allowProjectConversation,
  )) {
    throw new Error(`현재 탭이 요청한 ChatGPT 대화 또는 프로젝트 범위가 아닙니다: ${tab?.url || "missing"}`);
  }
  return tab;
}

export async function findConversationTab(client, conversationUrl, preferredTabId, projectUrl = null) {
  const tabs = await callTool(client, "tabs_list", { short: false });
  const normalizedConversation = normalizeConversationUrl(conversationUrl);
  const normalizedProject = normalizeProjectUrl(projectUrl);
  if (projectUrl && !normalizedProject) {
    throw new Error(`ChatGPT 프로젝트 홈 URL이 올바르지 않습니다: ${projectUrl}`);
  }
  if (conversationUrl && normalizedProject
      && !conversationBelongsToProject(conversationUrl, normalizedProject)) {
    throw new Error("기록된 대화가 지정한 ChatGPT 프로젝트에 속하지 않습니다.");
  }
  const preferred = selectPreferredTab(tabs, preferredTabId, conversationUrl, normalizedProject);
  if (preferred) return preferred;
  if (conversationUrl) {
    const exact = tabs.find((tab) => normalizeConversationUrl(tab.url) === normalizedConversation);
    if (exact) return exact;
    const reopened = await callTool(client, "tab_new", { url: normalizedConversation });
    const reopenedId = Number(reopened?.id ?? reopened?.tabId);
    if (!Number.isInteger(reopenedId)) {
      throw new Error(`기록된 ChatGPT 대화 탭을 다시 열지 못했습니다: ${conversationUrl}`);
    }
    return assertActionTabScope(client, reopenedId, {
      conversation_url: normalizedConversation,
      project_url: normalizedProject,
    });
  }
  const startUrl = normalizedProject || "https://chatgpt.com/";
  const created = await callTool(client, "tab_new", { url: startUrl });
  const createdId = Number(created?.id ?? created?.tabId);
  if (!Number.isInteger(createdId)) throw new Error("새 ChatGPT 탭 ID를 받지 못했습니다.");
  return assertActionTabScope(client, createdId, {
    conversation_url: null,
    project_url: normalizedProject,
  });
}

async function waitForComposerReady(client, tabId, deadline, expectedFilename, minimumResults = 0) {
  let lastError = null;
  let lastResultCount = null;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    try {
      const pageSnapshot = await snapshot(client, tabId);
      const composer = selectComposer(pageSnapshot);
      const resultCount = resultElements(pageSnapshot, expectedFilename).length;
      if (resultCount < minimumResults) {
        throw new Error(`이전 결과물 로딩 대기 중 (${resultCount}/${minimumResults})`);
      }
      stableSamples = resultCount === lastResultCount ? stableSamples + 1 : 0;
      lastResultCount = resultCount;
      if (stableSamples >= 2) return { pageSnapshot, composer };
    } catch (error) {
      lastError = error;
    }
    await sleep(750);
  }
  throw lastError || new Error("ChatGPT 입력창 준비 시간이 초과됐습니다.");
}

export async function uploadFile(client, tabId, fileInputRef, filePath) {
  const stats = statSync(filePath);
  const target = Number.isInteger(fileInputRef)
    ? { ref: fileInputRef }
    : { selector: 'input[type="file"]' };
  if (stats.size <= BASE64_UPLOAD_LIMIT) {
    return callTool(client, "file_upload", {
      tabId,
      ...target,
      base64: readFileSync(filePath).toString("base64"),
      filename: path.basename(filePath),
      mimeType: "application/zip",
    });
  }
  return callTool(client, "file_upload", { tabId, ...target, path: path.resolve(filePath) });
}

async function waitForSendButton(client, tabId, deadline) {
  while (Date.now() < deadline) {
    const pageSnapshot = await snapshot(client, tabId);
    const send = selectSendButton(pageSnapshot);
    if (send) return send;
    await sleep(750);
  }
  throw new Error("첨부 완료 후 ChatGPT 전송 버튼이 활성화되지 않았습니다.");
}

async function waitForConversationUrl(client, tabId, deadline, projectUrl = null) {
  while (Date.now() < deadline) {
    const tab = await currentTab(client, tabId);
    if (isCanonicalConversationUrl(tab?.url)) {
      if (projectUrl && !conversationBelongsToProject(tab.url, projectUrl)) {
        throw new Error("새 대화가 지정한 ChatGPT 프로젝트 밖에서 생성됐습니다.");
      }
      return normalizeConversationUrl(tab.url);
    }
    const page = await callTool(client, "get_page_text", { tabId });
    if (isCanonicalConversationUrl(page?.url)) {
      if (projectUrl && !conversationBelongsToProject(page.url, projectUrl)) {
        throw new Error("새 대화가 지정한 ChatGPT 프로젝트 밖에서 생성됐습니다.");
      }
      return normalizeConversationUrl(page.url);
    }
    await sleep(750);
  }
  throw new Error("새 ChatGPT 대화 URL을 확인하지 못했습니다.");
}

export async function submitAction(client, tab, action, deadline, runDir, minimumResults) {
  await assertActionTabScope(client, tab.id, action);
  const { pageSnapshot, composer } = await waitForComposerReady(
    client,
    tab.id,
    deadline,
    action.expected_download,
    minimumResults,
  );
  const baselineResults = resultElements(pageSnapshot, action.expected_download).length;
  const originalPrompt = action.prompt_file
    ? readFileSync(action.prompt_file, "utf8")
    : action.prompt;
  const marker = `submission_key: ${action.submission_key}`;
  const prompt = `${marker}\n\n${originalPrompt}`;
  const pendingPath = path.join(runDir, PENDING_SUBMISSION_FILE);
  const pending = {
    schema_version: 1,
    submission_key: action.submission_key,
    action: action.action,
    tab_id: tab.id,
    marker,
    baseline_results: baselineResults,
    expected_download: action.expected_download,
    attachments: (action.attachments || []).map((item) => path.basename(item)),
    stage: "composing",
    created_at: new Date().toISOString(),
  };
  writeJson(pendingPath, pending);
  await assertActionTabScope(client, tab.id, action);
  await callTool(client, "fill", { tabId: tab.id, ref: composer.textbox.ref, value: prompt });
  for (const attachment of action.attachments || []) {
    await assertActionTabScope(client, tab.id, action);
    await uploadFile(client, tab.id, composer.fileInput?.ref, attachment);
  }
  const send = await waitForSendButton(client, tab.id, deadline);
  pending.stage = "ready";
  writeJson(pendingPath, pending);
  await assertActionTabScope(client, tab.id, action);
  await callTool(client, "click", { tabId: tab.id, ref: send.ref, timeoutMs: 10_000 });
  pending.stage = "clicked";
  writeJson(pendingPath, pending);
  if (process.env.BROWSER_LOOP_TEST_FAILPOINT === "after-click") {
    throw new Error("테스트 실패 지점: ChatGPT 전송 직후");
  }
  const conversationUrl = action.conversation_url
    || await waitForConversationUrl(client, tab.id, deadline, action.project_url);
  return { conversationUrl, baselineResults, recovered: false };
}

export async function recoverPendingSubmission(client, action, pending, deadline, runDir) {
  if (pending.submission_key !== action.submission_key) {
    throw new Error("현재 제출 키와 보류된 브라우저 제출 키가 다릅니다.");
  }
  const tab = await assertActionTabScope(client, Number(pending.tab_id), action, true);
  const recoveryDeadline = Math.min(deadline, Date.now() + 15_000);
  while (Date.now() < recoveryDeadline) {
    let pageSnapshot = await snapshot(client, tab.id);
    const draft = (pageSnapshot.elements || []).find(
      (element) => element.role === "textbox"
        && element.inViewport !== false
        && String(element.label || "").includes(pending.marker),
    );
    if (draft) {
      for (const attachment of action.attachments || []) {
        const filename = path.basename(attachment);
        const attached = (pageSnapshot.elements || []).some(
          (element) => String(element.label || "").includes(filename),
        );
        if (!attached) {
          await assertActionTabScope(client, tab.id, action, true);
          const composer = selectComposer(pageSnapshot);
          await uploadFile(client, tab.id, composer.fileInput?.ref, attachment);
          pageSnapshot = await snapshot(client, tab.id);
        }
      }
      const send = await waitForSendButton(client, tab.id, deadline);
      await assertActionTabScope(client, tab.id, action, true);
      await callTool(client, "click", { tabId: tab.id, ref: send.ref, timeoutMs: 10_000 });
      pending.stage = "clicked_after_recovery";
      writeJson(path.join(runDir, PENDING_SUBMISSION_FILE), pending);
      const conversationUrl = action.conversation_url
        || await waitForConversationUrl(client, tab.id, deadline, action.project_url);
      return { conversationUrl, baselineResults: pending.baseline_results, recovered: true, tab };
    }
    const page = await callTool(client, "get_page_text", { tabId: tab.id });
    const refreshedTab = await currentTab(client, tab.id);
    const pageUrl = isCanonicalConversationUrl(page?.url)
      ? normalizeConversationUrl(page.url)
      : (isCanonicalConversationUrl(refreshedTab?.url) ? normalizeConversationUrl(refreshedTab.url) : null);
    if (pageUrl && String(page?.text || "").includes(pending.marker)) {
      return { conversationUrl: pageUrl, baselineResults: pending.baseline_results, recovered: true, tab };
    }
    await sleep(750);
  }
  throw new Error("제출 결과가 불확실해 중복 제출을 차단했습니다. ChatGPT 대화를 직접 확인하세요.");
}

export function validatePendingDownload(pending, action, state) {
  if (!pending) {
    throw new Error("다운로드 기준 기록이 없어 이전 결과물 선택을 차단했습니다.");
  }
  const latestSubmission = (state.submissions || []).at(-1);
  if (!latestSubmission || pending.submission_key !== latestSubmission.submission_key) {
    throw new Error("다운로드 기준의 제출 키가 현재 상태와 다릅니다.");
  }
  if (pending.expected_download !== action.expected_download) {
    throw new Error("다운로드 기준의 파일명이 현재 작업과 다릅니다.");
  }
  if (normalizeConversationUrl(pending.conversation_url)
      !== normalizeConversationUrl(state.conversation_url)) {
    throw new Error("다운로드 기준의 대화 URL이 현재 상태와 다릅니다.");
  }
  if (!Number.isInteger(pending.baseline_results) || pending.baseline_results < 0) {
    throw new Error("다운로드 기준 결과 개수가 올바르지 않습니다.");
  }
  return pending.baseline_results;
}

async function waitForResult(client, tabId, expectedFilename, baselineResults, deadline) {
  let lastProgressAt = 0;
  while (Date.now() < deadline) {
    const pageSnapshot = await snapshot(client, tabId);
    const candidates = resultElements(pageSnapshot, expectedFilename);
    if (candidates.length > baselineResults) return candidates.at(-1);
    if (Date.now() - lastProgressAt > 15_000) {
      console.log(`[대기] ${expectedFilename} 생성 중`);
      lastProgressAt = Date.now();
    }
    await sleep(1500);
  }
  throw new Error(`${expectedFilename} 생성 대기 시간이 초과됐습니다.`);
}

function listDownloadCandidates(downloadDir, expectedFilename) {
  if (!existsSync(downloadDir)) return [];
  return readdirSync(downloadDir)
    .filter((name) => isExpectedDownload(name, expectedFilename))
    .map((name) => {
      const filePath = path.join(downloadDir, name);
      const stats = statSync(filePath);
      return { path: filePath, name, size: stats.size, mtimeMs: stats.mtimeMs };
    });
}

export async function clickAndCaptureDownload(
  client,
  tabId,
  resultElement,
  expectedFilename,
  downloadDir,
  deadline,
) {
  const sourceTab = await currentTab(client, tabId);
  const sourceUrl = normalizeConversationUrl(sourceTab?.url);
  const before = new Map(
    listDownloadCandidates(downloadDir, expectedFilename)
      .map((item) => [item.path, `${item.size}:${item.mtimeMs}`]),
  );
  const cutoff = Date.now() - 1500;
  await callTool(client, "click", { tabId, ref: resultElement.ref, timeoutMs: 10_000 });
  let previous = null;
  let redirectedUrl = null;
  while (Date.now() < deadline) {
    const fresh = listDownloadCandidates(downloadDir, expectedFilename)
      .filter((item) => item.mtimeMs >= cutoff && before.get(item.path) !== `${item.size}:${item.mtimeMs}`)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
    if (fresh && fresh.size > 0) {
      if (previous?.path === fresh.path && previous.size === fresh.size) {
        return {
          path: fresh.path,
          transient: false,
          method: "browser-download",
          conversationRestored: true,
        };
      }
      previous = fresh;
    }
    const tab = await currentTab(client, tabId);
    if (isChatGptDownloadUrl(tab?.url) && tab.url !== redirectedUrl) {
      redirectedUrl = tab.url;
      const transientPath = path.join(
        downloadDir,
        `.browser-loop-${process.pid}-${Date.now()}-${path.basename(expectedFilename)}`,
      );
      await callTool(client, "download_resource", {
        url: redirectedUrl,
        savePath: transientPath,
        timeoutMs: Math.max(30_000, deadline - Date.now()),
      });
      if (!existsSync(transientPath) || statSync(transientPath).size === 0) {
        throw new Error(`${expectedFilename} 직접 다운로드 결과가 비어 있습니다.`);
      }
      let conversationRestored = false;
      if (sourceUrl) {
        await callTool(client, "navigate", { tabId, url: sourceUrl });
        const restoredTab = await currentTab(client, tabId);
        conversationRestored = normalizeConversationUrl(restoredTab?.url) === sourceUrl;
        if (!conversationRestored) {
          throw new Error("직접 다운로드 후 원래 ChatGPT 대화로 복귀하지 못했습니다.");
        }
      }
      return {
        path: transientPath,
        transient: true,
        method: "bridge-download-resource",
        conversationRestored,
      };
    }
    await sleep(500);
  }
  throw new Error(`${expectedFilename} 다운로드를 확인하지 못했습니다.`);
}

function saveAutomationReport(runDir, report) {
  writeFileSync(
    path.join(runDir, "browser-automation-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
}

function loadAutomationReport(runDir) {
  const reportPath = path.join(runDir, "browser-automation-report.json");
  if (!existsSync(reportPath)) return null;
  return JSON.parse(readFileSync(reportPath, "utf8"));
}

export async function runLoop(options) {
  const statePath = path.join(options.runDir, "state.json");
  if (!existsSync(statePath)) throw new Error(`state.json이 없습니다: ${statePath}`);
  const client = await connectBridge(options.bridgeRoot);
  const report = resumeAutomationReport(loadAutomationReport(options.runDir), new Date().toISOString());
  try {
    const diagnostic = await doctor(client);
    report.bridge = {
      serverVersion: diagnostic.status.serverVersion,
      extensionVersion: diagnostic.status.extension?.version,
      extensionConnected: diagnostic.health.extensionConnected,
    };
    console.log(`[정상] Browser Bridge ${report.bridge.serverVersion}, Chrome 확장 연결됨`);
    let preferredTabId = options.tabId;
    const pendingSubmissionPath = path.join(options.runDir, PENDING_SUBMISSION_FILE);
    const pendingDownloadPath = path.join(options.runDir, PENDING_DOWNLOAD_FILE);
    while (true) {
      const state = readState(options.runDir);
      const action = runHarness(["next-action", "--run-dir", options.runDir]);
      if (action.action === "none") {
        removeIfExists(pendingSubmissionPath);
        removeIfExists(pendingDownloadPath);
        report.finished_at = new Date().toISOString();
        report.final_status = state.status;
        saveAutomationReport(options.runDir, report);
        return state;
      }
      const deadline = Date.now() + options.timeoutSeconds * 1000;
      if (["submit_initial", "submit_feedback"].includes(action.action)) {
        removeIfExists(pendingDownloadPath);
        const pendingSubmission = readJsonIfExists(pendingSubmissionPath);
        let tab;
        let submitted;
        if (pendingSubmission) {
          submitted = await recoverPendingSubmission(
            client,
            action,
            pendingSubmission,
            deadline,
            options.runDir,
          );
          tab = submitted.tab;
        } else {
          tab = await findConversationTab(
            client,
            state.conversation_url,
            preferredTabId,
            action.project_url,
          );
          submitted = await submitAction(
            client,
            tab,
            action,
            deadline,
            options.runDir,
            state.attempts.length,
          );
        }
        preferredTabId = tab.id;
        writeJson(pendingDownloadPath, {
          schema_version: 1,
          submission_key: action.submission_key,
          tab_id: tab.id,
          conversation_url: submitted.conversationUrl,
          expected_download: action.expected_download,
          baseline_results: submitted.baselineResults,
          created_at: new Date().toISOString(),
        });
        runHarness([
          "record-submission",
          "--run-dir", options.runDir,
          "--kind", action.action === "submit_initial" ? "initial" : "feedback",
          "--url", submitted.conversationUrl,
        ]);
        report.events.push({
          action: action.action,
          submission_key: action.submission_key,
          conversation_url: submitted.conversationUrl,
          attachments: (action.attachments || []).map((item) => path.basename(item)),
          baseline_results: submitted.baselineResults,
          recovered: submitted.recovered,
        });
        removeIfExists(pendingSubmissionPath);
        saveAutomationReport(options.runDir, report);
        console.log(`[제출] ${action.action} → ${submitted.conversationUrl}`);
        continue;
      }
      removeIfExists(pendingSubmissionPath);
      const pendingDownload = readJsonIfExists(pendingDownloadPath);
      const baselineResults = validatePendingDownload(pendingDownload, action, state);
      const tab = await findConversationTab(
        client,
        state.conversation_url,
        Number(pendingDownload.tab_id),
        action.project_url,
      );
      preferredTabId = tab.id;
      const resultElement = await waitForResult(
        client,
        tab.id,
        action.expected_download,
        baselineResults,
        deadline,
      );
      const downloaded = await clickAndCaptureDownload(
        client,
        tab.id,
        resultElement,
        action.expected_download,
        options.downloadDir,
        deadline,
      );
      const attempt = state.attempts.length + 1;
      const parsed = path.parse(action.expected_download);
      const destinationDir = path.join(options.runDir, "downloads");
      mkdirSync(destinationDir, { recursive: true });
      const destination = path.join(
        destinationDir,
        `${parsed.name}-${String(attempt).padStart(3, "0")}${parsed.ext}`,
      );
      copyFileSync(downloaded.path, destination);
      if (downloaded.transient) removeIfExists(downloaded.path);
      const verification = runHarness(
        ["verify", "--run-dir", options.runDir, "--result-zip", destination],
        [0, 2],
      );
      report.events.push({
        action: "verify",
        attempt,
        status: verification.status,
        result_sha256: verification.result_sha256,
        downloaded_as: path.basename(destination),
        download_method: downloaded.method,
        conversation_restored: downloaded.conversationRestored,
      });
      removeIfExists(pendingDownloadPath);
      saveAutomationReport(options.runDir, report);
      console.log(`[검증] 시도 ${attempt} → ${verification.status}`);
    }
  } catch (error) {
    report.finished_at = new Date().toISOString();
    report.final_status = "error";
    report.error = { message: error.message };
    saveAutomationReport(options.runDir, report);
    throw error;
  } finally {
    await client.close();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runLoop(options);
    console.log(JSON.stringify({ status: result.status, run_dir: options.runDir }, null, 2));
    process.exitCode = result.status === "verified" ? 0 : 2;
  } catch (error) {
    console.error(JSON.stringify({ status: "error", error: error.message }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  await main();
}
