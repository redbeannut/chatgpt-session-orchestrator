// JSON manifest 하나로 기존 하네스를 준비하고 최대 3개 ChatGPT 작업자를 실행한다.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { orchestratorStatus, registerWorker, runOperations } from "./orchestrator.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}가 필요합니다.`);
  return value.trim();
}

function resolveFrom(baseDir, value, label) {
  return path.resolve(baseDir, requireText(value, label));
}

export function loadManifest(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const baseDir = path.dirname(absoluteManifest);
  const manifest = JSON.parse(readFileSync(absoluteManifest, "utf8"));
  if (manifest.schema_version !== 1) throw new Error("지원하지 않는 manifest 버전입니다.");
  if (!Array.isArray(manifest.workers) || !Array.isArray(manifest.jobs)) {
    throw new Error("manifest에 workers와 jobs 배열이 필요합니다.");
  }
  if (manifest.workers.length < 1 || manifest.workers.length > 3
      || manifest.jobs.length < 1 || manifest.jobs.length > 3) {
    throw new Error("workers와 jobs는 각각 1~3개여야 합니다.");
  }
  const dispatchIntervalMs = manifest.dispatch_interval_ms ?? 60_000;
  if (!Number.isInteger(dispatchIntervalMs) || dispatchIntervalMs < 60_000) {
    throw new Error("라이브 ChatGPT 제출 간격은 최소 60000ms여야 합니다.");
  }
  return {
    stateDir: resolveFrom(baseDir, manifest.state_dir, "state_dir"),
    dispatchIntervalMs,
    workers: manifest.workers.map((worker) => ({
      workerId: requireText(worker.worker_id, "worker_id"),
      tabId: worker.tab_id,
      projectUrl: requireText(worker.project_url, "project_url"),
      capabilities: worker.capabilities ?? [],
    })),
    jobs: manifest.jobs.map((job) => ({
      runDir: resolveFrom(baseDir, job.run_dir, "run_dir"),
      spec: resolveFrom(baseDir, job.spec, "spec"),
      workerId: requireText(job.worker_id, "worker_id"),
      requiredCapabilities: job.required_capabilities ?? [],
      timeoutSeconds: job.timeout_seconds ?? 300,
    })),
  };
}

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: PROJECT_ROOT, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} 실패: 종료 코드 ${result.status}`);
}

function prepareJob(job) {
  if (existsSync(path.join(job.runDir, "state.json"))) return;
  if (existsSync(job.runDir)) throw new Error(`state.json 없는 실행 폴더가 이미 존재합니다: ${job.runDir}`);
  run("python", [
    path.join(PROJECT_ROOT, "src", "harness.py"),
    "prepare",
    "--run-dir", job.runDir,
    "--spec", job.spec,
  ], `작업 준비 ${job.runDir}`);
}

export async function executeManifest(manifestPath) {
  const config = loadManifest(manifestPath);
  run("powershell", [
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(PROJECT_ROOT, "scripts", "start_browser_bridge.ps1"),
  ], "Browser Bridge 시작");
  config.jobs.forEach(prepareJob);
  config.workers.forEach((worker) => registerWorker(config.stateDir, worker));
  await runOperations({
    stateDir: config.stateDir,
    jobs: config.jobs,
    dispatchIntervalMs: config.dispatchIntervalMs,
  });
  return orchestratorStatus(config.stateDir);
}

async function main() {
  const index = process.argv.indexOf("--manifest");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--manifest <path>가 필요합니다.");
  const state = await executeManifest(process.argv[index + 1]);
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
