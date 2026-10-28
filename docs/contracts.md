# pi-agent-orchestrator contracts

This document is the shared contract for every module in the package. Config,
broker core, HTTP API, worker adapters and the Pi extension build against it.

## Paths

| Purpose | Default |
|---|---|
| Project config | `.pi/agents.yml` (or an explicit path) |
| Durable broker state | `.pi/agent-orchestrator/` |
| Broker URL | `http://127.0.0.1:<port>` (`port: 0` picks a free port) |
| Dashboard | `<broker URL>/` when `server.dashboard: true` |

Bind to loopback only. Remote/multi-host operation is out of scope for v1.

## YAML config

```yaml
version: 1

server:
  host: 127.0.0.1   # only loopback; "localhost" is accepted and normalized
  port: 8787        # 0 = ephemeral
  dashboard: true

defaults:           # optional; applied per agent
  effort: medium
  replicas: 1
  tools: [read, grep, find, ls, bash]

agents:             # required, at least one role
  architect:
    role: architect # optional; defaults to the map key
    description: >-
      Break requirements into a plan. Identify reuse, interfaces and risks.
    model: anthropic/claude-sonnet-4-5
    provider: anthropic # optional
    effort: high        # optional: off|minimal|low|medium|high|xhigh|max
    replicas: 1         # 1..16, defaults.replicas, then 1
    cwd: .              # optional, relative to project root
    tools: [read, grep, find, ls] # optional allow-list

  developer:
    description: Implement assigned work and run the relevant checks.
    model: anthropic/claude-sonnet-4-5
    effort: medium
    replicas: 2
```

Rules enforced by `src/config.ts`:

- `version` defaults to `1`; only `1` is accepted.
- Unknown keys are rejected. Exception: any key starting with `x-` is ignored,
  so annotations do not fail validation.
- `description` and `model` are required non-empty strings.
- `role` defaults to the `agents` map key and must be unique. `#` is reserved
  for replica ids (`role#1`, `role#2`, ...).
- `effort` is case-insensitive and normalized to lower case. It is a role hint;
  the worker runtime resolves it to Pi's thinking level.
- `replicas` is an integer from 1 through 16. Defaults come from
  `defaults.replicas`, then 1.
- `tools` is an array of non-empty tool names; duplicates are removed.
- Config loading does not resolve model ids to Pi models. Use `ModelResolver` at
  runtime. `parseModelSpec("provider/model")` splits on the first `/` only.
- `configFingerprint` is the sha256 of canonical JSON (object keys recursively
  sorted) of the normalized config. Reload compares fingerprints.

`loadConfig({ path?, cwd? })` returns `{ config, configFingerprint, path }`.
`parseConfig(raw)` validates an already-parsed YAML object. Both throw
`ConfigError` with an `issues: string[]` list.

## Task and agent state machines

Task statuses:

```
queued -> assigned -> running -> awaiting_review -> closed
             |           |             |
             |           |             +-- rework --> running
             |           |
             +-----------+-- failure / cancel --> failed | cancelled
```

- `queued`: waiting for an idle replica of the requested role.
- `assigned`: a replica is locked and the worker is starting/resetting.
- `running`: worker is executing the prompt (attempt >= 1).
- `awaiting_review`: result is ready; the replica stays locked.
- `closed`: reviewer accepted the result. Terminal.
- `failed`: worker or broker error. Terminal.
- `cancelled`: explicitly cancelled before close. Terminal.
- `rework`: `awaiting_review -> running` with reviewer feedback. This is the
  only non-terminal transition that preserves worker context.

Agent replica statuses: `starting`, `idle`, `busy`, `awaiting_review`,
`resetting`, `error`, `stopped`. A replica reports `awaiting_review` for the same
period as its locked task.

`src/state.ts` owns the pure transition/lock helpers:
`TASK_TRANSITIONS`, `canTransitionTask`, `assertTaskTransition`,
`isTerminalTaskStatus`, `taskHoldsAgentLock`, `assertAgentTaskLock`.

## Lock invariant

A replica serves at most one task at a time, from assignment through review:

1. Dispatch only to an agent with `status === "idle"` and no `currentTaskId`.
2. On assignment set `agent.currentTaskId` and task `agentId` in one state
   update, before starting the worker.
3. `assigned`, `running` and `awaiting_review` all hold the lock.
4. `close` releases the lock, resets the worker context, and only then may the
   replica take another queued task.
5. `rework` keeps `agentId` and context, moves the task back to `running`, and
   sends the feedback through `WorkerAdapter.feedback`.
6. `failed` and `cancelled` release the lock (abort/stop the worker as needed)
   and reset or replace the worker before reuse.
7. Never dispatch a second task to a replica whose `currentTaskId` is set, even
   if that task is awaiting review.

## HTTP API

All routes are under the broker origin. JSON in, JSON out. SSE at
`GET /api/events`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | `HealthView`: broker status, counts, fingerprint, uptime |
| `GET` | `/api/config` | Normalized config plus fingerprint |
| `GET` | `/api/agents` | `AgentView[]` (config, status, lock, last action, stats) |
| `GET` | `/api/tasks` | `TaskView[]`; optional `?status=&role=&agentId=` |
| `GET` | `/api/tasks/:id` | One `TaskView` |
| `GET` | `/api/events` | SSE stream; first event is `snapshot`, then updates |
| `POST` | `/api/tasks` | Body `{ title, role, prompt, acceptance? }` -> created task |
| `POST` | `/api/tasks/:id/review` | Body `{ decision: "close" \| "rework", feedback? }` |
| `POST` | `/api/tasks/:id/cancel` | Cancel a non-terminal task |
| `POST` | `/api/reload` | Re-read config, validate, apply fingerprint/roster rules |
| `POST` | `/api/shutdown` | Graceful broker shutdown |
| `GET` | `/` and dashboard assets | Framework-free HTML dashboard when enabled |

Submit response is the created `Task` (usually `status: "queued"`).
Review/cancel responses return the updated task. `rework` requires non-empty
`feedback`; `close` ignores feedback.

### Errors

Non-2xx responses use this shape:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "role \"nobody\" is not defined in .pi/agents.yml",
    "details": { "role": "nobody" }
  }
}
```

Suggested codes: `invalid_request` (400), `not_found` (404), `conflict` (409,
wrong state / agent locked / review race), `config_error` (422),
`internal_error` (500). Errors must never leak worker stdout; worker stderr is
for broker logs only.

### SSE

Every event is `data: <JSON>\n\n` with:

```ts
{
  seq: number;        // monotonic broker sequence
  at: string;         // ISO timestamp
  type: "snapshot" | "agent.updated" | "task.updated" | "task.log" | "broker.updated";
  data: unknown;      // snapshot: BrokerState
                      // agent.updated: { agent: AgentView }
                      // task.updated: { task: TaskView }
                      // task.log:    { taskId, entry: TaskLogEntry }
                      // broker.updated: { health: HealthView }
}
```

Reconnect support: clients may send `Last-Event-ID`; `seq` is also present in
every payload. The dashboard consumes the same stream the extension uses.

## Worker adapter contract

```ts
interface WorkerAdapter {
  start(): Promise<void>;
  run(task: Task, onEvent: (event: WorkerEvent) => void): Promise<WorkerResult>;
  feedback(message: string, onEvent: (event: WorkerEvent) => void): Promise<WorkerResult>;
  reset(): Promise<void>;
  stop(): Promise<void>;
  abort?(): Promise<void>;
}

interface WorkerFactory {
  create(agent: AgentRuntime): WorkerAdapter;
}
```

Rules:

- One adapter instance per long-lived replica/context.
- `run` is called only while the replica holds the task lock. It emits
  `started`, then any `text` / `tool_start` / `tool_end` / `usage` events, then
  `completed` or `failed`, and resolves/rejects accordingly.
- `feedback` continues the same context after a rework decision and returns the
  new result. It must not start a fresh session.
- `reset` discards context (Pi `new_session` / equivalent) before another
  unrelated task. Context reset increments the fake worker epoch.
- `stop` terminates the process/session; `abort` (optional) interrupts the
  current run without destroying the replica.
- Worker events are converted to task logs and SSE `task.log` events. Worker
  adapters never write protocol frames or logs to broker stdout.

`src/testing/fake-worker.ts` implements this contract deterministically with an
injectable clock, delays, failures and epoch counter. Integration tests use it;
the real adapter uses `RpcClient` against a Pi RPC subprocess.

## Core interface

`OrchestratorCore` in `src/types.ts` is the only surface used by the HTTP server
and Pi extension:

```ts
start(): Promise<void>;
stop(): Promise<void>;
submit(input): Promise<Task>;
waitForReview(taskId, timeoutMs?): Promise<Task>;
review(taskId, decision, feedback?): Promise<Task>;
cancel(taskId): Promise<Task>;
listAgents(): AgentView[];
listTasks(filter?): TaskView[];
getTask(taskId): TaskView | undefined;
getSnapshot(): BrokerState;
subscribe(listener): () => void;
reload(): Promise<OrchestratorConfig>;
```

`waitForReview` resolves when the task reaches `awaiting_review` and rejects on
timeout or terminal failure. `subscribe` returns an unsubscribe function.
