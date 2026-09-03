// Browser Bridge를 통해 ChatGPT 파일 왕복과 로컬 검증을 자동 반복한다.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
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
  return new RegExp(`^${escape(parsed.name)}(?:\\s*\\(\\d+\\))?${escape(parsed.ext)}$`, "i");
}

export function isExpectedDownload(filename, expected) {
  return expectedDownloadRegex(expected).test(filename) && !filename.endsWith(".crdownload");
}

export function normalizeConversationUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function isCanonicalConversationUrl(rawUrl) {
  const normalized = normalizeConversationUrl(rawUrl);
  return Boolean(
    normalized
    && normalized.startsWith("https://chatgpt.com/c/")
    && !normalized.includes("/c/WEB:"),
  );
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
    (element) => element.tag === "input" && element.type === "file" && element.inViewport !== false,
  );
  if (!textboxes.length) throw new Error("ChatGPT 입력창을 찾지 못했습니다.");
  if (!fileInputs.length) throw new Error("ChatGPT 파일 입력을 찾지 못했습니다.");
  return { textbox: textboxes.at(-1), fileInput: fileInputs[0] };
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
    { name: "chatgpt-browser-loop", version: "0.3.0" },
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

async function findConversationTab(client, conversationUrl, preferredTabId) {
  const tabs = await callTool(client, "tabs_list", { short: false });
  const normalizedConversation = normalizeConversationUrl(conversationUrl);
  if (preferredTabId !== null) {
    const preferred = tabs.find((tab) => tab.id === preferredTabId);
    if (preferred && (!conversationUrl || normalizeConversationUrl(preferred.url) === normalizedConversation)) {
      return preferred;
    }
  }
  if (conversationUrl) {
    const exact = tabs.find((tab) => normalizeConversationUrl(tab.url) === normalizedConversation);
    if (exact) return exact;
    const reopened = await callTool(client, "tab_new", { url: normalizedConversation });
    const reopenedId = Number(reopened?.id ?? reopened?.tabId);
    if (!Number.isInteger(reopenedId)) {
      throw new Error(`기록된 ChatGPT 대화 탭을 다시 열지 못했습니다: ${conversationUrl}`);
    }
    return { id: reopenedId, url: normalizedConversation };
  }
  const created = await callTool(client, "tab_new", { url: "https://chatgpt.com/" });
  const createdId = Number(created?.id ?? created?.tabId);
  if (!Number.isInteger(createdId)) throw new Error("새 ChatGPT 탭 ID를 받지 못했습니다.");
  return { id: createdId, url: "https://chatgpt.com/" };
}

async function waitForComposerReady(client, tabId, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const pageSnapshot = await snapshot(client, tabId);
      const composer = selectComposer(pageSnapshot);
      return { pageSnapshot, composer };
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw lastError || new Error("ChatGPT 입력창 준비 시간이 초과됐습니다.");
}

async function uploadFile(client, tabId, fileInputRef, filePath) {
  const stats = statSync(filePath);
  if (stats.size <= BASE64_UPLOAD_LIMIT) {
    return callTool(client, "file_upload", {
      tabId,
      ref: fileInputRef,
      base64: readFileSync(filePath).toString("base64"),
      filename: path.basename(filePath),
      mimeType: "application/zip",
    });
  }
  return callTool(client, "file_upload", { tabId, ref: fileInputRef, path: path.resolve(filePath) });
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

async function waitForConversationUrl(client, tabId, deadline) {
  while (Date.now() < deadline) {
    const tab = await currentTab(client, tabId);
    if (isCanonicalConversationUrl(tab?.url)) return normalizeConversationUrl(tab.url);
    const page = await callTool(client, "get_page_text", { tabId });
    if (isCanonicalConversationUrl(page?.url)) return normalizeConversationUrl(page.url);
    await sleep(750);
  }
  throw new Error("새 ChatGPT 대화 URL을 확인하지 못했습니다.");
}

async function submitAction(client, tab, action, deadline) {
  const { pageSnapshot, composer } = await waitForComposerReady(client, tab.id, deadline);
  const baselineResults = resultElements(pageSnapshot, action.expected_download).length;
  const prompt = action.prompt_file
    ? readFileSync(action.prompt_file, "utf8")
    : action.prompt;
  await callTool(client, "fill", { tabId: tab.id, ref: composer.textbox.ref, value: prompt });
  for (const attachment of action.attachments || []) {
    await uploadFile(client, tab.id, composer.fileInput.ref, attachment);
  }
  const send = await waitForSendButton(client, tab.id, deadline);
  await callTool(client, "click", { tabId: tab.id, ref: send.ref, timeoutMs: 10_000 });
  const conversationUrl = action.conversation_url
    || await waitForConversationUrl(client, tab.id, deadline);
  return { conversationUrl, baselineResults };
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

async function clickAndCaptureDownload(client, tabId, resultElement, expectedFilename, downloadDir, deadline) {
  const before = new Map(
    listDownloadCandidates(downloadDir, expectedFilename)
      .map((item) => [item.path, `${item.size}:${item.mtimeMs}`]),
  );
  const cutoff = Date.now() - 1500;
  await callTool(client, "click", { tabId, ref: resultElement.ref, timeoutMs: 10_000 });
  let previous = null;
  while (Date.now() < deadline) {
    const fresh = listDownloadCandidates(downloadDir, expectedFilename)
      .filter((item) => item.mtimeMs >= cutoff && before.get(item.path) !== `${item.size}:${item.mtimeMs}`)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
    if (fresh && fresh.size > 0) {
      if (previous?.path === fresh.path && previous.size === fresh.size) return fresh.path;
      previous = fresh;
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
    let pendingBaselineResults = null;
    while (true) {
      const state = readState(options.runDir);
      const action = runHarness(["next-action", "--run-dir", options.runDir]);
      if (action.action === "none") {
        report.finished_at = new Date().toISOString();
        report.final_status = state.status;
        saveAutomationReport(options.runDir, report);
        return state;
      }
      const deadline = Date.now() + options.timeoutSeconds * 1000;
      const tab = await findConversationTab(client, state.conversation_url, preferredTabId);
      preferredTabId = tab.id;
      if (["submit_initial", "submit_feedback"].includes(action.action)) {
        const submitted = await submitAction(client, tab, action, deadline);
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
        });
        pendingBaselineResults = submitted.baselineResults;
        saveAutomationReport(options.runDir, report);
        console.log(`[제출] ${action.action} → ${submitted.conversationUrl}`);
        continue;
      }
      const baselineResults = pendingBaselineResults ?? state.attempts.length;
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
      copyFileSync(downloaded, destination);
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
      });
      pendingBaselineResults = null;
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
