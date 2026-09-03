import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadManifest } from "../src/orchestrator_cli.mjs";

function writeManifest(value) {
  const root = mkdtempSync(path.join(os.tmpdir(), "orchestrator-cli-"));
  const target = path.join(root, "manifest.json");
  writeFileSync(target, JSON.stringify(value), "utf8");
  return target;
}

test("manifest resolves paths and preserves the safe dispatch interval", () => {
  const target = writeManifest({
    schema_version: 1,
    state_dir: "state",
    workers: [{
      worker_id: "research-a",
      tab_id: 101,
      project_url: "https://chatgpt.com/g/g-p-12345678901234567890123456789012/project",
      capabilities: ["research"],
    }],
    jobs: [{
      run_dir: "runs/a",
      spec: "specs/a.json",
      worker_id: "research-a",
      required_capabilities: ["research"],
    }],
  });
  const config = loadManifest(target);
  assert.equal(config.dispatchIntervalMs, 60_000);
  assert.equal(config.jobs[0].workerId, "research-a");
  assert.equal(config.jobs[0].runDir, path.join(path.dirname(target), "runs", "a"));
});

test("manifest rejects unsafe live dispatch intervals", () => {
  const target = writeManifest({
    schema_version: 1,
    state_dir: "state",
    dispatch_interval_ms: 0,
    workers: [{ worker_id: "a", project_url: "https://chatgpt.com/g/g-p-12345678901234567890123456789012/project" }],
    jobs: [{ run_dir: "a", spec: "a.json", worker_id: "a" }],
  });
  assert.throws(() => loadManifest(target), /최소 60000ms/);
});
