// 최대 3개의 ChatGPT 브라우저 작업자를 임대하고 실행 상태를 이벤트 로그로 복구한다.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  conversationBelongsToProject,
  isCanonicalConversationUrl,
  normalizeConversationUrl,
  normalizeProjectUrl,
  parseArgs,
  runLoop,
} from "./browser_bridge_loop.mjs";

const EVENT_LOG = "orchestrator-events.jsonl";
const MAX_WORKERS = 3;
const TERMINAL_STATES = new Set(["COMPLETED", "FAILED"]);
const ACTIVE_OPERATIONS = new Set();

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}가 필요합니다.`);
  return value.trim();
}

function normalizeCapabilities(values = []) {
  if (!Array.isArray(values)) throw new Error("capabilities는 배열이어야 합니다.");
  return [...new Set(values.map((value) => requireText(value, "capability").toLowerCase()))].sort();
}

function eventPath(stateDir) {
  return path.join(path.resolve(stateDir), EVENT_LOG);
}

export function readOrchestratorEvents(stateDir) {
  const target = eventPath(stateDir);
  if (!existsSync(target)) return [];
  return readFileSync(target, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`오케스트레이터 이벤트 ${index + 1}번째 줄이 올바른 JSON이 아닙니다.`);
      }
    });
}

function applyEvent(state, event) {
  const worker = event.worker_id ? state.workers[event.worker_id] : null;
  const operation = event.operation_id ? state.operations[event.operation_id] : null;
  if (event.type === "WORKER_REGISTERED") {
    if (worker) throw new Error(`작업자가 이미 등록돼 있습니다: ${event.worker_id}`);
    if (Object.keys(state.workers).length >= MAX_WORKERS) {
      throw new Error(`작업자는 최대 ${MAX_WORKERS}개까지 등록할 수 있습니다.`);
    }
    state.workers[event.worker_id] = {
      worker_id: event.worker_id,
      capabilities: event.capabilities,
      project_url: event.project_url,
      tab_id: event.tab_id,
      conversation_url: null,
      state: "available",
      operation_id: null,
    };
  } else if (event.type === "OPERATION_CREATED") {
    if (operation) throw new Error(`작업이 이미 존재합니다: ${event.operation_id}`);
    state.operations[event.operation_id] = {
      operation_id: event.operation_id,
      job_id: event.job_id,
      run_dir: event.run_dir,
      project_url: event.project_url,
      required_capabilities: event.required_capabilities,
      input_artifact_hash: event.input_artifact_hash,
      state: "CREATED",
      attempt: 0,
      worker_id: null,
    };
  } else if (event.type === "WORKER_LEASED") {
    if (!worker || !operation) throw new Error("등록된 작업자와 작업만 임대할 수 있습니다.");
    if (worker.state !== "available" || operation.state !== "CREATED") {
      throw new Error("사용 가능한 작업자와 생성된 작업만 연결할 수 있습니다.");
    }
    worker.state = "leased";
    worker.operation_id = operation.operation_id;
    operation.state = "LEASED";
    operation.worker_id = worker.worker_id;
  } else if (event.type === "OPERATION_STATE_CHANGED") {
    if (!operation) throw new Error(`작업을 찾지 못했습니다: ${event.operation_id}`);
    const allowed = operation.state === "LEASED"
      ? ["RUNNING"]
      : operation.state === "RUNNING"
        ? ["RUNNING", "COMPLETED", "FAILED"]
        : [];
    if (!allowed.includes(event.state)) {
      throw new Error(`허용되지 않은 작업 상태 전이입니다: ${operation.state} → ${event.state}`);
    }
    operation.state = event.state;
    if (event.state === "RUNNING") operation.attempt += 1;
    if (event.harness_status !== undefined) operation.harness_status = event.harness_status;
    if (event.output_artifact_hash !== undefined) {
      operation.output_artifact_hash = event.output_artifact_hash;
    }
    if (event.failure_fingerprint !== undefined) {
      operation.failure_fingerprint = event.failure_fingerprint;
    }
    if (event.error !== undefined) operation.error = event.error;
  } else if (event.type === "WORKER_BOUND") {
    if (!worker || worker.operation_id !== event.operation_id) {
      throw new Error("임대한 작업자만 대화 URL에 연결할 수 있습니다.");
    }
    worker.conversation_url = event.conversation_url;
  } else if (event.type === "WORKER_RELEASED") {
    if (!worker || !operation || worker.operation_id !== operation.operation_id) {
      throw new Error("현재 작업에 임대한 작업자만 해제할 수 있습니다.");
    }
    if (!TERMINAL_STATES.has(operation.state)) {
      throw new Error("완료 또는 실패한 작업의 작업자만 해제할 수 있습니다.");
    }
    worker.state = "available";
    worker.operation_id = null;
  } else {
    throw new Error(`알 수 없는 오케스트레이터 이벤트입니다: ${event.type}`);
  }
  return state;
}

export function replayOrchestrator(events) {
  return events.reduce(applyEvent, { schema_version: 1, workers: {}, operations: {} });
}

function appendEvent(stateDir, type, data) {
  // ponytail: 한 coordinator 프로세스가 로그를 소유한다. 다중 프로세스가 필요해지면 파일 잠금을 추가한다.
  const event = {
    schema_version: 1,
    event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    type,
    ...data,
  };
  const events = readOrchestratorEvents(stateDir);
  applyEvent(replayOrchestrator(events), event);
  mkdirSync(path.resolve(stateDir), { recursive: true });
  appendFileSync(eventPath(stateDir), `${JSON.stringify(event)}\n`, "utf8");
  return replayOrchestrator([...events, event]);
}

function sameWorker(existing, candidate) {
  return existing.project_url === candidate.project_url
    && existing.tab_id === candidate.tab_id
    && JSON.stringify(existing.capabilities) === JSON.stringify(candidate.capabilities);
}

export function registerWorker(stateDir, definition) {
  const worker = {
    worker_id: requireText(definition.workerId, "workerId"),
    capabilities: normalizeCapabilities(definition.capabilities),
    project_url: definition.projectUrl ? normalizeProjectUrl(definition.projectUrl) : null,
    tab_id: definition.tabId ?? null,
  };
  if (definition.projectUrl && !worker.project_url) {
    throw new Error(`ChatGPT 프로젝트 홈 URL이 올바르지 않습니다: ${definition.projectUrl}`);
  }
  if (worker.tab_id !== null && (!Number.isInteger(worker.tab_id) || worker.tab_id <= 0)) {
    throw new Error("tabId는 양의 정수여야 합니다.");
  }
  const state = replayOrchestrator(readOrchestratorEvents(stateDir));
  const existing = state.workers[worker.worker_id];
  if (existing) {
    if (!sameWorker(existing, worker)) throw new Error(`작업자 정의가 기존 등록과 다릅니다: ${worker.worker_id}`);
    return state;
  }
  return appendEvent(stateDir, "WORKER_REGISTERED", worker);
}

function readHarnessState(runDir) {
  const statePath = path.join(path.resolve(runDir), "state.json");
  if (!existsSync(statePath)) throw new Error(`state.json이 없습니다: ${statePath}`);
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function reuseWorkerConversation(runDir, worker) {
  if (!worker.conversation_url) return;
  const statePath = path.join(path.resolve(runDir), "state.json");
  const state = readHarnessState(runDir);
  if (state.conversation_url) {
    if (normalizeConversationUrl(state.conversation_url) !== worker.conversation_url) {
      throw new Error("실행 폴더와 작업자의 ChatGPT 대화 URL이 다릅니다.");
    }
    return;
  }
  if (state.status !== "prepared") {
    throw new Error("준비 상태의 작업만 기존 작업자 대화에 연결할 수 있습니다.");
  }
  if (worker.project_url
      && !conversationBelongsToProject(worker.conversation_url, worker.project_url)) {
    throw new Error("작업자 프로젝트 밖의 대화 URL은 재사용할 수 없습니다.");
  }
  state.conversation_url = worker.conversation_url;
  state.updated_at = new Date().toISOString();
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function ensureOperation(stateDir, job, harnessState) {
  const operationId = requireText(harnessState.operation_id, "operation_id");
  const requiredCapabilities = normalizeCapabilities(job.requiredCapabilities);
  const projectUrl = harnessState.project_url ? normalizeProjectUrl(harnessState.project_url) : null;
  let state = replayOrchestrator(readOrchestratorEvents(stateDir));
  const existing = state.operations[operationId];
  if (existing) {
    if (existing.run_dir !== path.resolve(job.runDir)) {
      throw new Error(`작업 실행 폴더가 기존 기록과 다릅니다: ${operationId}`);
    }
    return state;
  }
  state = appendEvent(stateDir, "OPERATION_CREATED", {
    operation_id: operationId,
    job_id: job.jobId || operationId,
    run_dir: path.resolve(job.runDir),
    project_url: projectUrl,
    required_capabilities: requiredCapabilities,
    input_artifact_hash: harnessState.context_sha256 || null,
  });
  return state;
}

function leaseWorker(stateDir, operationId, preferredWorkerId = null) {
  const state = replayOrchestrator(readOrchestratorEvents(stateDir));
  const operation = state.operations[operationId];
  if (!operation) throw new Error(`작업을 찾지 못했습니다: ${operationId}`);
  if (operation.worker_id) return state;
  const candidates = Object.values(state.workers)
    .filter((worker) => worker.state === "available")
    .filter((worker) => worker.project_url === operation.project_url)
    .filter((worker) => operation.required_capabilities.every(
      (capability) => worker.capabilities.includes(capability),
    ))
    .filter((worker) => !preferredWorkerId || worker.worker_id === preferredWorkerId)
    .sort((left, right) => left.worker_id.localeCompare(right.worker_id));
  if (!candidates.length) throw new Error(`사용 가능한 작업자가 없습니다: ${operationId}`);
  return appendEvent(stateDir, "WORKER_LEASED", {
    operation_id: operationId,
    worker_id: candidates[0].worker_id,
  });
}

function changeOperationState(stateDir, operationId, state, details = {}) {
  return appendEvent(stateDir, "OPERATION_STATE_CHANGED", {
    operation_id: operationId,
    state,
    ...details,
  });
}

function bindConversation(stateDir, worker, operation, conversationUrl) {
  const normalized = normalizeConversationUrl(conversationUrl);
  if (!normalized || !isCanonicalConversationUrl(normalized)) {
    throw new Error(`정식 ChatGPT 대화 URL이 아닙니다: ${conversationUrl}`);
  }
  if (worker.project_url && !conversationBelongsToProject(normalized, worker.project_url)) {
    throw new Error("작업자 프로젝트 밖의 대화 URL은 연결할 수 없습니다.");
  }
  return appendEvent(stateDir, "WORKER_BOUND", {
    operation_id: operation.operation_id,
    worker_id: worker.worker_id,
    conversation_url: normalized,
  });
}

function releaseWorker(stateDir, operationId, workerId) {
  return appendEvent(stateDir, "WORKER_RELEASED", {
    operation_id: operationId,
    worker_id: workerId,
  });
}

export class BrowserSessionAdapter {
  constructor(runner = runLoop) {
    this.runner = runner;
  }

  execute(worker, options) {
    const argv = [
      "--run-dir", options.runDir,
      "--timeout-seconds", String(options.timeoutSeconds ?? 300),
    ];
    if (options.bridgeRoot) argv.push("--bridge-root", options.bridgeRoot);
    if (options.downloadDir) argv.push("--download-dir", options.downloadDir);
    const normalized = parseArgs(argv);
    return this.runner({ ...normalized, tabId: worker.tab_id ?? options.tabId ?? null });
  }
}

export async function runOperation({ stateDir, job, adapter = new BrowserSessionAdapter() }) {
  const harnessState = readHarnessState(job.runDir);
  const operationId = requireText(harnessState.operation_id, "operation_id");
  if (ACTIVE_OPERATIONS.has(operationId)) {
    throw new Error(`같은 작업이 이미 실행 중입니다: ${operationId}`);
  }
  ACTIVE_OPERATIONS.add(operationId);
  try {
    let state = ensureOperation(stateDir, job, harnessState);
    let operation = state.operations[operationId];
    if (TERMINAL_STATES.has(operation.state)) {
      const terminalWorker = state.workers[operation.worker_id];
      if (terminalWorker?.operation_id === operationId) {
        state = releaseWorker(stateDir, operationId, terminalWorker.worker_id);
      }
      return state.operations[operationId];
    }
    state = leaseWorker(stateDir, operationId, job.workerId || null);
    operation = state.operations[operationId];
    const worker = state.workers[operation.worker_id];
    reuseWorkerConversation(job.runDir, worker);
    state = changeOperationState(stateDir, operationId, "RUNNING");
    try {
      const result = await adapter.execute(worker, {
        runDir: path.resolve(job.runDir),
        timeoutSeconds: job.timeoutSeconds ?? 300,
        ...(job.bridgeRoot ? { bridgeRoot: path.resolve(job.bridgeRoot) } : {}),
        ...(job.downloadDir ? { downloadDir: path.resolve(job.downloadDir) } : {}),
      });
      const finalHarnessState = readHarnessState(job.runDir);
      if (finalHarnessState.conversation_url
          && finalHarnessState.conversation_url !== worker.conversation_url) {
        state = bindConversation(
          stateDir,
          state.workers[worker.worker_id],
          state.operations[operationId],
          finalHarnessState.conversation_url,
        );
      }
      const latestAttempt = finalHarnessState.attempts?.at(-1) || {};
      const terminalState = result.status === "verified" ? "COMPLETED" : "FAILED";
      state = changeOperationState(stateDir, operationId, terminalState, {
        harness_status: result.status,
        output_artifact_hash: latestAttempt.result_sha256 || null,
        failure_fingerprint: latestAttempt.failure_fingerprint || null,
      });
      return releaseWorker(stateDir, operationId, worker.worker_id).operations[operationId];
    } catch (error) {
      let errorMessage = error.message;
      try {
        const failedHarnessState = readHarnessState(job.runDir);
        if (failedHarnessState.conversation_url
            && failedHarnessState.conversation_url !== worker.conversation_url) {
          state = bindConversation(
            stateDir,
            state.workers[worker.worker_id],
            state.operations[operationId],
            failedHarnessState.conversation_url,
          );
        }
      } catch (bindingError) {
        errorMessage += `; 대화 URL 기록 실패: ${bindingError.message}`;
      }
      state = changeOperationState(stateDir, operationId, "FAILED", { error: errorMessage });
      releaseWorker(stateDir, operationId, state.operations[operationId].worker_id);
      throw error;
    }
  } finally {
    ACTIVE_OPERATIONS.delete(operationId);
  }
}

export async function runOperations({ stateDir, jobs, adapter = new BrowserSessionAdapter() }) {
  if (!Array.isArray(jobs) || jobs.length === 0 || jobs.length > MAX_WORKERS) {
    throw new Error(`jobs는 1~${MAX_WORKERS}개여야 합니다.`);
  }
  return Promise.all(jobs.map((job) => runOperation({ stateDir, job, adapter })));
}

export function orchestratorStatus(stateDir) {
  // ponytail: 개인용 3-worker 로그는 매번 전체 재생한다. 이벤트가 수만 건이면 스냅샷을 추가한다.
  return replayOrchestrator(readOrchestratorEvents(stateDir));
}
