#!/usr/bin/env node
/**
 * Dependency-free end-to-end demo against the built broker and fake workers.
 *
 *   npm run build && node scripts/demo.mjs
 *
 * It starts dist/broker/main.js in a temporary state directory, submits sample
 * tasks, demonstrates rework + close review, prints agent state and shuts down.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brokerEntry = path.join(root, "dist", "broker", "main.js");
const configPath = path.join(root, "examples", "agents.yml");

if (!existsSync(brokerEntry)) {
  console.error("dist/broker/main.js is missing. Run `npm run build` first.");
  process.exit(1);
}

const stateDir = await mkdtemp(path.join(tmpdir(), "pi-orchestrator-demo-"));
const descriptorPath = path.join(stateDir, "broker.json");
const logPath = path.join(stateDir, "broker.log");
const child = spawn(
  process.execPath,
  [brokerEntry, "--config", configPath, "--state-dir", stateDir, "--port", "0", "--fake-worker", "--daemon"],
  { cwd: root, stdio: "ignore", env: { ...process.env, PI_ORCHESTRATOR_FAKE_WORKER: "1" } },
);

let baseUrl;
let cleanedUp = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLog() {
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return "(no broker log yet)";
  }
}

async function waitForBroker(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
      const response = await fetch(`http://127.0.0.1:${descriptor.port}/api/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.ok && health.pid === descriptor.pid) {
          baseUrl = `http://127.0.0.1:${descriptor.port}`;
          return descriptor;
        }
      }
    } catch {
      // Not ready yet.
    }
    if (child.exitCode !== null) {
      throw new Error(`broker exited with code ${child.exitCode}\n${await readLog()}`);
    }
    await sleep(100);
  }
  throw new Error(`broker did not become healthy\n${await readLog()}`);
}

async function api(method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`${method} ${route} -> ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function waitForTasks(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tasks = await api("GET", "/api/tasks");
    if (predicate(tasks)) return tasks;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function printTasks(tasks, heading) {
  console.log(`\n${heading}`);
  for (const task of tasks) {
    const agent = task.agentId ?? "-";
    const result = (task.result ?? task.error ?? "").split("\n")[0];
    console.log(
      `  ${task.id.slice(0, 8)}  ${task.status.padEnd(16)} ${task.role.padEnd(10)} ` +
        `${agent.padEnd(14)} attempts=${task.attempts}  ${result}`,
    );
  }
}

function printAgents(agents, heading) {
  console.log(`\n${heading}`);
  for (const agent of agents) {
    console.log(
      `  ${agent.id.padEnd(14)} ${agent.status.padEnd(16)} task=${agent.currentTaskId?.slice(0, 8) ?? "-"} ` +
        `model=${agent.model} effort=${agent.effort ?? "-"} last="${agent.lastAction ?? "-"}"`,
    );
  }
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  if (baseUrl) {
    await api("POST", "/api/shutdown").catch(() => undefined);
  }
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(50);
  if (child.exitCode === null) child.kill("SIGTERM");
  await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
}

process.once("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});

try {
  const descriptor = await waitForBroker();
  console.log(`broker ready: ${baseUrl} (pid ${descriptor.pid})`);
  console.log(`config: ${configPath}`);
  console.log(`state:  ${stateDir}`);

  const agents = await api("GET", "/api/agents");
  printAgents(agents, "Agent pool:");

  const submissions = [
    {
      title: "Add task queue metrics",
      role: "backend",
      prompt: "Add counters for queued/running/reviewed tasks and unit tests.",
      acceptance: "Counters are exposed and tests pass.",
    },
    {
      title: "Build review controls",
      role: "frontend",
      prompt: "Add close/rework controls to the task detail panel.",
      acceptance: "Controls work with keyboard and screen readers.",
    },
    {
      title: "Review the plan",
      role: "architect",
      prompt: "Check the queue design for lock leaks and recovery edge cases.",
    },
  ];
  const created = await Promise.all(submissions.map((task) => api("POST", "/api/tasks", task)));
  printTasks(created, "Submitted tasks:");

  const reviewed = await waitForTasks(
    (tasks) => tasks.filter((task) => task.status === "awaiting_review").length === created.length,
    "all tasks to await review",
  );
  printTasks(reviewed, "Tasks awaiting review (replicas stay locked):");
  printAgents(await api("GET", "/api/agents"), "Locked agent pool:");

  const backend = reviewed.find((task) => task.role === "backend");
  const frontend = reviewed.find((task) => task.role === "frontend");
  const architect = reviewed.find((task) => task.role === "architect");
  if (!backend || !frontend || !architect) throw new Error("sample tasks missing after dispatch");

  console.log(`\nRework ${backend.id.slice(0, 8)} in the same worker context...`);
  await api("POST", `/api/tasks/${backend.id}/review`, {
    decision: "rework",
    feedback: "Add a regression test for the reset-before-redispatch path.",
  });
  const reworked = await waitForTasks(
    (tasks) => tasks.some((task) => task.id === backend.id && task.status === "awaiting_review" && task.attempts >= 2),
    "reworked task",
  );
  printTasks(reworked, "After rework:");

  for (const task of [backend, frontend, architect]) {
    await api("POST", `/api/tasks/${task.id}/review`, { decision: "close" });
  }
  console.log("\nClosed all tasks; replicas were reset before becoming idle.");

  const deadline = Date.now() + 5_000;
  let finalAgents = await api("GET", "/api/agents");
  while (Date.now() < deadline && finalAgents.some((agent) => agent.status !== "idle")) {
    await sleep(100);
    finalAgents = await api("GET", "/api/agents");
  }
  printAgents(finalAgents, "Final agent pool:");

  const finalTasks = await api("GET", "/api/tasks");
  printTasks(finalTasks, "Final tasks:");
  console.log("\nDemo complete.");
  await cleanup();
  process.exit(0);
} catch (error) {
  console.error(`\nDemo failed: ${error.stack ?? error.message}`);
  await cleanup();
  process.exit(1);
}
