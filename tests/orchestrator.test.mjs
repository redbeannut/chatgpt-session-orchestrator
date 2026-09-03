// 다중 ChatGPT 작업자 임대와 이벤트 로그 기반 복구를 검증한다.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BrowserSessionAdapter,
  orchestratorStatus,
  readOrchestratorEvents,
  registerWorker,
  runOperation,
  runOperations,
} from "../src/orchestrator.mjs";

function createRun(root, name, projectUrl = null) {
  const runDir = path.join(root, name);
  mkdirSync(runDir);
  const state = {
    operation_id: randomUUID(),
    project_url: projectUrl,
    conversation_url: null,
    context_sha256: `input-${name}`,
    status: "prepared",
    attempts: [],
  };
  writeFileSync(path.join(runDir, "state.json"), `${JSON.stringify(state)}\n`, "utf8");
  return { runDir, state };
}

function updateRun(runDir, worker, status = "verified") {
  const target = path.join(runDir, "state.json");
  const state = JSON.parse(readFileSync(target, "utf8"));
  const conversationId = randomUUID();
  state.conversation_url ||= state.project_url
    ? state.project_url.replace(/\/project$/, `/c/${conversationId}`)
    : `https://chatgpt.com/c/${conversationId}`;
  state.status = status;
  state.attempts = [{
    result_sha256: `output-${worker.worker_id}`,
    failure_fingerprint: status === "verified" ? null : `failure-${worker.worker_id}`,
  }];
  writeFileSync(target, `${JSON.stringify(state)}\n`, "utf8");
  return state;
}

test("작업자 등록은 멱등이며 최대 3개로 제한한다", () => {
  const root = mkdtempSync(path.join(tmpdir(), "orchestrator-registry-"));
  try {
    for (const workerId of ["worker-a", "worker-b", "worker-c"]) {
      registerWorker(root, { workerId, capabilities: ["Research", "coding"] });
    }
    const before = readOrchestratorEvents(root).length;
    registerWorker(root, { workerId: "worker-a", capabilities: ["coding", "research"] });
    assert.equal(readOrchestratorEvents(root).length, before);
    assert.throws(
      () => registerWorker(root, { workerId: "worker-d", capabilities: [] }),
      /최대 3개/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("프로젝트와 capability가 맞는 작업자만 임대한다", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orchestrator-project-"));
  const projectUrl = "https://chatgpt.com/g/g-p-browser-loop-test/project";
  try {
    const job = createRun(root, "project-job", projectUrl);
    const stateDir = path.join(root, "state");
    registerWorker(stateDir, { workerId: "general", capabilities: ["research"] });
    registerWorker(stateDir, {
      workerId: "project-researcher",
      projectUrl,
      tabId: 42,
      capabilities: ["research"],
    });
    const seen = [];
    const adapter = {
      async execute(worker, options) {
        const before = JSON.parse(readFileSync(path.join(options.runDir, "state.json"), "utf8"));
        seen.push({ worker, options, conversationUrlBeforeRun: before.conversation_url });
        return updateRun(options.runDir, worker);
      },
    };
    const result = await runOperation({
      stateDir,
      job: { runDir: job.runDir, requiredCapabilities: ["research"] },
      adapter,
    });
    assert.equal(result.state, "COMPLETED");
    assert.equal(result.worker_id, "project-researcher");
    assert.equal(seen[0].worker.tab_id, 42);
    const status = orchestratorStatus(stateDir);
    assert.equal(status.workers["project-researcher"].tab_id, 42);
    assert.match(status.workers["project-researcher"].conversation_url, /\/g\/g-p-browser-loop-test\/c\//);

    const previousConversation = status.workers["project-researcher"].conversation_url;
    const secondJob = createRun(root, "project-job-2", projectUrl);
    await runOperation({
      stateDir,
      job: { runDir: secondJob.runDir, requiredCapabilities: ["research"] },
      adapter,
    });
    assert.equal(seen[1].worker.worker_id, "project-researcher");
    assert.equal(seen[1].conversationUrlBeforeRun, previousConversation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("대화 생성 후 실행이 실패해도 작업자에 URL을 보존하고 다음 작업에서 재사용한다", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orchestrator-failed-conversation-"));
  const projectUrl = "https://chatgpt.com/g/g-p-browser-loop-test/project";
  try {
    const stateDir = path.join(root, "state");
    registerWorker(stateDir, {
      workerId: "project-worker",
      projectUrl,
      capabilities: ["research"],
    });
    const failedJob = createRun(root, "failed-after-conversation", projectUrl);
    await assert.rejects(
      runOperation({
        stateDir,
        job: { runDir: failedJob.runDir, requiredCapabilities: ["research"] },
        adapter: {
          async execute(worker, options) {
            updateRun(options.runDir, worker);
            throw new Error("download timeout");
          },
        },
      }),
      /download timeout/,
    );

    let status = orchestratorStatus(stateDir);
    const preservedConversation = status.workers["project-worker"].conversation_url;
    assert.match(preservedConversation, /\/g\/g-p-browser-loop-test\/c\//);
    assert.equal(status.workers["project-worker"].state, "available");
    assert.equal(status.operations[failedJob.state.operation_id].state, "FAILED");

    const nextJob = createRun(root, "next-after-failure", projectUrl);
    let conversationBeforeRun = null;
    await runOperation({
      stateDir,
      job: { runDir: nextJob.runDir, requiredCapabilities: ["research"] },
      adapter: {
        async execute(worker, options) {
          const before = JSON.parse(readFileSync(path.join(options.runDir, "state.json"), "utf8"));
          conversationBeforeRun = before.conversation_url;
          return updateRun(options.runDir, worker);
        },
      },
    });
    assert.equal(conversationBeforeRun, preservedConversation);
    status = orchestratorStatus(stateDir);
    assert.equal(status.operations[nextJob.state.operation_id].state, "COMPLETED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("완료 이벤트 직후 중단돼도 재실행하면 작업자를 해제한다", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orchestrator-release-recovery-"));
  try {
    const stateDir = path.join(root, "state");
    const job = createRun(root, "completed-before-release");
    mkdirSync(stateDir);
    const events = [
      {
        type: "WORKER_REGISTERED",
        worker_id: "worker-a",
        capabilities: ["coding"],
        project_url: null,
        tab_id: null,
      },
      {
        type: "OPERATION_CREATED",
        operation_id: job.state.operation_id,
        job_id: job.state.operation_id,
        run_dir: path.resolve(job.runDir),
        project_url: null,
        required_capabilities: ["coding"],
        input_artifact_hash: job.state.context_sha256,
      },
      { type: "WORKER_LEASED", operation_id: job.state.operation_id, worker_id: "worker-a" },
      { type: "OPERATION_STATE_CHANGED", operation_id: job.state.operation_id, state: "RUNNING" },
      {
        type: "OPERATION_STATE_CHANGED",
        operation_id: job.state.operation_id,
        state: "COMPLETED",
        harness_status: "verified",
      },
    ];
    writeFileSync(
      path.join(stateDir, "orchestrator-events.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
    let calls = 0;
    const result = await runOperation({
      stateDir,
      job: { runDir: job.runDir, requiredCapabilities: ["coding"] },
      adapter: { async execute() { calls += 1; } },
    });
    assert.equal(result.state, "COMPLETED");
    assert.equal(calls, 0);
    assert.equal(orchestratorStatus(stateDir).workers["worker-a"].state, "available");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("같은 operation은 한 프로세스에서 동시에 실행하지 않는다", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orchestrator-duplicate-"));
  try {
    const stateDir = path.join(root, "state");
    registerWorker(stateDir, { workerId: "worker-a", capabilities: ["coding"] });
    const job = createRun(root, "duplicate");
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const adapter = {
      async execute(worker, options) {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const result = updateRun(options.runDir, worker);
        active -= 1;
        return result;
      },
    };
    const definition = { stateDir, job: { runDir: job.runDir, requiredCapabilities: ["coding"] }, adapter };
    const results = await Promise.allSettled([runOperation(definition), runOperation(definition)]);
    assert.equal(calls, 1);
    assert.equal(maxActive, 1);
    assert.deepEqual(results.map((item) => item.status).sort(), ["fulfilled", "rejected"]);
    assert.match(results.find((item) => item.status === "rejected").reason.message, /이미 실행 중/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BrowserSessionAdapter는 등록된 Chrome 탭을 기존 실행기에 전달한다", async () => {
  let received = null;
  const adapter = new BrowserSessionAdapter(async (options) => {
    received = options;
    return { status: "verified" };
  });
  await adapter.execute({ tab_id: 73 }, { runDir: "run", timeoutSeconds: 90 });
  assert.equal(received.tabId, 73);
  assert.equal(received.timeoutSeconds, 90);
});

test("세 작업을 서로 다른 작업자에서 동시에 실행하고 모두 해제한다", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orchestrator-batch-"));
  try {
    const stateDir = path.join(root, "state");
    for (const workerId of ["worker-a", "worker-b", "worker-c"]) {
      registerWorker(stateDir, { workerId, capabilities: ["research"] });
    }
    const runs = ["job-a", "job-b", "job-c"].map((name) => createRun(root, name));
    let active = 0;
    let maxActive = 0;
    const adapter = {
      async execute(worker, options) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const result = updateRun(options.runDir, worker);
        active -= 1;
        return result;
      },
    };
    const results = await runOperations({
      stateDir,
      jobs: runs.map(({ runDir }) => ({ runDir, requiredCapabilities: ["research"] })),
      adapter,
    });
    assert.equal(maxActive, 3);
    assert.deepEqual(results.map((item) => item.state), ["COMPLETED", "COMPLETED", "COMPLETED"]);
    const status = orchestratorStatus(stateDir);
    assert.deepEqual(
      Object.values(status.workers).map((worker) => worker.state),
      ["available", "available", "available"],
    );
    assert.equal(new Set(Object.values(status.operations).map((item) => item.worker_id)).size, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("실패한 작업은 기록 후 작업자를 해제하고 완료 작업은 재실행하지 않는다", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "orchestrator-recovery-"));
  try {
    const stateDir = path.join(root, "state");
    registerWorker(stateDir, { workerId: "worker-a", capabilities: ["coding"] });
    const failedRun = createRun(root, "failed");
    await assert.rejects(
      runOperation({
        stateDir,
        job: { runDir: failedRun.runDir, requiredCapabilities: ["coding"] },
        adapter: { async execute() { throw new Error("bridge stopped"); } },
      }),
      /bridge stopped/,
    );
    let status = orchestratorStatus(stateDir);
    assert.equal(status.operations[failedRun.state.operation_id].state, "FAILED");
    assert.equal(status.workers["worker-a"].state, "available");

    const completedRun = createRun(root, "completed");
    let calls = 0;
    const adapter = {
      async execute(worker, options) {
        calls += 1;
        return updateRun(options.runDir, worker);
      },
    };
    await runOperation({
      stateDir,
      job: { runDir: completedRun.runDir, requiredCapabilities: ["coding"] },
      adapter,
    });
    await runOperation({
      stateDir,
      job: { runDir: completedRun.runDir, requiredCapabilities: ["coding"] },
      adapter,
    });
    assert.equal(calls, 1);
    status = orchestratorStatus(stateDir);
    assert.equal(status.operations[completedRun.state.operation_id].attempt, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
