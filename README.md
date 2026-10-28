# pi-agent-orchestrator

A local orchestration broker and [Pi](https://pi.dev) extension for a **fixed roster of long-lived agent workers**.

You define roles once in `.pi/agents.yml` (instructions, model, thinking effort, replica count). A single loopback broker keeps a pool of Pi RPC worker processes alive, queues work, and dispatches each task only to an **idle replica of the requested role**. A replica is locked to a task from assignment through review: nothing else can run on it until the orchestrating Pi session explicitly closes or rejects (reworks) the result. Closing a task resets the worker context before the replica becomes idle again; rework continues the same context with reviewer feedback.

- No remote hosting, no dynamic agents, no auth/RBAC: v1 binds to `127.0.0.1` only.
- Durable task state and recovery across broker restarts.
- Framework-free browser dashboard with the same close/rework controls.
- Real Pi RPC workers by default, deterministic fake workers for tests and demos.
- Recurring **schedules** for long-running checks (for example a regression review every 30 minutes), with manual trigger and dashboard controls.

## Architecture

```
┌──────────────────────────┐        HTTP + SSE         ┌────────────────────────────┐
│ Pi session (extension)   │  ───────────────────────▶ │ Broker daemon              │
│ agent_dispatch/_wait/    │  ◀─────────────────────── │ · scheduler + lock checks  │
│ _status/_review/_cancel  │      tasks / events       │ · queue + replica pool     │
│ /agents command          │                           │ · state.json + task logs   │
└──────────────────────────┘                           │ · HTTP API + SSE           │
                                                       └───────────┬────────────────┘
                                                                   │ WorkerAdapter
                                        ┌──────────────────────────┼──────────────────────────┐
                                        │                          │                          │
                                  ┌─────▼─────┐              ┌─────▼─────┐              ┌─────▼─────┐
                                  │ architect │              │ backend#1 │              │ backend#2 │
                                  │ Pi RPC    │              │ Pi RPC    │              │ Pi RPC    │
                                  └───────────┘              └───────────┘              └───────────┘
                                                                   │
                                              browser dashboard ◀──┘  http://127.0.0.1:<port>/
```

The extension autostarts one detached broker per project when `.pi/agents.yml` exists. Worker processes run with `PI_AGENT_ORCHESTRATOR_WORKER=1`, which makes the extension skip registration and prevents recursive broker startup.

## Installation

From this repository:

```bash
npm install
npm run build

# Install into Pi (package mode)
pi install ./

# Or run Pi with the extension for one session
pi -e ./
```

The package exposes the extension at `dist/extension.js` via the `pi.extensions` manifest entry. Node.js 20 or newer is required. `@earendil-works/pi-*` packages are peer dependencies provided by Pi.

## Configuration

Copy [`examples/agents.yml`](examples/agents.yml) to `.pi/agents.yml` in your project and adjust model ids to your Pi model catalogue.

```yaml
version: 1

server:
  host: 127.0.0.1   # loopback only
  port: 8787        # 0 = ephemeral
  dashboard: true

defaults:
  effort: medium
  replicas: 1
  tools: [read, grep, find, ls, edit, write, bash]

agents:
  backend:
    description: >-
      Implement backend work. Add tests and report exact commands/results.
    model: deepseek/deepseek-chat
    provider: deepseek
    effort: medium
    replicas: 2
    cwd: .

schedules:                       # optional recurring checks
  - id: recent-bug-review
    role: backend                # must exist under agents
    title: Recent bug review
    every: 30m                   # 30s, 15m, 2h, 1d
    prompt: >-
      Review the most recent changes for regressions, missing tests and risky
      edge cases. Report findings with file:line references.
    overlap: skip                # skip while the previous occurrence is open
    runOnStart: false
```

### YAML schema

| Key | Type | Required | Behavior |
|---|---|---|---|
| `version` | integer | no | Must be `1`; defaults to `1`. |
| `server.host` | string | no | `127.0.0.1` or `localhost` (normalized). Non-loopback values are rejected. |
| `server.port` | integer | no | `0`–`65535`; `0` picks a free port. Default `0`. |
| `server.dashboard` | boolean | no | Serve the HTML dashboard. Default `true`. |
| `defaults.effort` | string | no | Fallback effort for roles. |
| `defaults.replicas` | integer | no | Fallback replica count (1–16), then `1`. |
| `defaults.tools` | string[] | no | Fallback Pi tool allow-list. |
| `agents` | map | **yes** | At least one role; keys are role names. |
| `agents.<role>.description` | string | **yes** | Work instructions sent to the worker. |
| `agents.<role>.model` | string | **yes** | `provider/model` or a bare model id. |
| `agents.<role>.provider` | string | no | Explicit provider; otherwise parsed from `model`. |
| `agents.<role>.role` | string | no | Overrides the map key; must be unique and cannot contain `#`. |
| `agents.<role>.effort` | string | no | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (case-insensitive). |
| `agents.<role>.replicas` | integer | no | 1–16 long-lived replicas. |
| `agents.<role>.cwd` | string | no | Working directory relative to the project root. |
| `agents.<role>.tools` | string[] | no | Pi tool allow-list for that role. |
| `schedules` | array | no | Recurring checks. Each due occurrence creates a normal task. |
| `schedules[].id` | string | **yes** | Unique schedule id; cannot contain `:`. |
| `schedules[].role` | string | **yes** | Role that runs the check; must exist in `agents`. |
| `schedules[].every` | string | **yes** | Interval (`500ms` minimum), e.g. `30s`, `15m`, `2h`, `1d`. |
| `schedules[].prompt` | string | **yes** | Work instructions for each occurrence. |
| `schedules[].title` | string | no | Task title; defaults to the first prompt line. |
| `schedules[].acceptance` | string | no | Acceptance criteria copied onto each task. |
| `schedules[].enabled` | boolean | no | Default `true`; disabled schedules only run manually. |
| `schedules[].runOnStart` | boolean | no | Run once immediately when first created/enabled. |
| `schedules[].overlap` | `"skip" \| "queue"` | no | Default `skip`: do not pile up occurrences while the previous task is open. |

Unknown keys are rejected; prefix annotations with `x-` (for example `x-owner`) to pass them through. Model ids are validated against the live Pi model catalogue when the broker starts, before any worker is spawned. Effort is mapped to the model's supported Pi thinking level and fails fast when unsupported.

## Quickstart

```bash
cp examples/agents.yml .pi/agents.yml   # edit model ids first
npm run build

# Start the broker yourself (optional; the extension autostarts it)
node dist/broker/main.js --config .pi/agents.yml

# Or start a Pi session in this project; /agents status shows the pool
pi
```

Then ask Pi to use the tools, for example:

> Dispatch a backend task titled "Add pagination" with acceptance criteria, wait for review, then close it if the result is good.

Or from a shell:

```bash
curl -s http://127.0.0.1:8787/api/agents
curl -s -X POST http://127.0.0.1:8787/api/tasks \
  -H 'content-type: application/json' \
  -d '{"title":"Add pagination","role":"backend","prompt":"Implement pagination with tests."}'
```

Try the whole lifecycle without model calls:

```bash
npm run build
node scripts/demo.mjs
```

The demo starts a fake-worker broker in a temporary state directory, submits backend/frontend/architect tasks, shows locked replicas, reworks one task in the same context, closes everything, prints the final pool, and shuts down.

## Tools

| Tool | Parameters | Purpose |
|---|---|---|
| `agent_dispatch` | `role`, `prompt`, optional `title`, `acceptance`, `clientRequestId` | Queue a task for a fixed role. Returns the task id; the replica is locked once assigned. |
| `agent_wait` | `taskId`, optional `timeoutMs` (default 120000, max 600000) | Long-poll until `awaiting_review`, `failed`, `cancelled`, or timeout. Does **not** release the lock. |
| `agent_status` | optional `taskId`, `role` | Broker health, replica status/lock/last action, recent tasks. |
| `agent_schedule` | `action` (`list`/`run`/`enable`/`disable`), optional `scheduleId` | Inspect recurring schedules, trigger one immediately, or toggle future occurrences. |
| `agent_review` | `taskId`, `decision` (`close` or `rework`), optional `feedback` | `close` accepts, releases the lock, and resets context. `rework` requires feedback and continues the same context. |
| `agent_cancel` | `taskId` | Cancel a non-terminal task, abort/release the worker, and reset or replace it. |

Slash command:

```
/agents [status|schedules|run <id>|enable <id>|disable <id>|dashboard|start|stop|reload|logs]
```

- `status` (default): health, replicas, and tasks.
- `dashboard`: ensure the broker is running and open its URL.
- `start` / `stop`: start the shared detached broker or shut it down.
- `reload`: re-read `.pi/agents.yml`; only allowed when no task holds a replica lock.
- `schedules`: list recurring checks with next/last run and latest task.
- `run <id>` / `enable <id>` / `disable <id>`: control a schedule without reloading.
- `logs [n]`: tail the broker log.

## Lifecycle and locking

```
queued ──▶ assigned ──▶ running ──▶ awaiting_review ──▶ closed
              │            │              │
              │            │              └─ rework ──▶ running (same context)
              └────────────┴──────────────┴─ failure / cancel ──▶ failed | cancelled
```

- Dispatch selects only a replica with `status === "idle"` and no `currentTaskId`.
- `assigned`, `running`, and `awaiting_review` all hold the lock. A replica never receives a second task while locked, even if its task is awaiting review.
- `close` releases the lock, resets the worker context, and only then may the replica take new work.
- `rework` keeps the replica and context, appends the feedback, and records another attempt.
- `failed` and `cancelled` release the lock; the worker is stopped/aborted and reset or replaced before reuse.
- Durable state (`state.json` plus per-task JSONL logs) is written atomically. On restart, queued tasks resume, in-flight tasks are recovered, and awaiting-review tasks stay locked until reviewed.
- Schedule state (`nextRunAt`, `lastRunAt`, last task) is durable. If the broker was down, an overdue schedule runs once and skips missed slots instead of replaying them all. `overlap: skip` prevents a recurring check from accumulating while its previous task is still open.

## HTTP API and dashboard

The broker listens on `http://127.0.0.1:<port>` and exposes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health, counts, uptime, config fingerprint |
| `GET` | `/api/config` | Normalized config (credential-like keys redacted) |
| `GET` | `/api/agents` | Replica views |
| `GET` | `/api/schedules` | Recurring schedules and their runtime state |
| `GET` | `/api/schedules/:id` | One schedule |
| `POST` | `/api/schedules/:id/run` | Trigger one occurrence now |
| `POST` | `/api/schedules/:id/enable` | Body `{ "enabled": boolean }` |
| `GET` | `/api/tasks` | Tasks, optional `?status=&role=&agentId=` |
| `GET` | `/api/tasks/:id` | One task |
| `GET` | `/api/events` | SSE: `snapshot`, then `agent.updated`, `task.updated`, `task.log`, `schedule.updated`, `broker.updated` |
| `POST` | `/api/tasks` | Submit `{ title, role, prompt, acceptance? }` |
| `POST` | `/api/tasks/:id/review` | `{ decision: "close" \| "rework", feedback? }` |
| `POST` | `/api/tasks/:id/cancel` | Cancel a non-terminal task |
| `POST` | `/api/reload` | Re-read config when no replica is locked |
| `POST` | `/api/shutdown` | Graceful shutdown (loopback only) |
| `GET` | `/` | Dashboard when `server.dashboard: true` |

The dashboard shows agents, replicas, current locked task, progress, latest actions/results, recurring schedules (next/last run, run-now, enable/disable), and close/rework controls. It consumes the same SSE stream as the extension.

## Paths

| Purpose | Default |
|---|---|
| Config | `.pi/agents.yml` (or `--config <path>`) |
| State directory | `.pi/agent-orchestrator/` (or `--state-dir <path>`) |
| Broker descriptor | `.pi/agent-orchestrator/broker.json` (`{pid, port, startedAt, configPath}`) |
| Broker log | `.pi/agent-orchestrator/broker.log` |
| Durable state | `.pi/agent-orchestrator/state.json` |
| Task logs | `.pi/agent-orchestrator/tasks/<taskId>.jsonl` |
| Worker sessions | `.pi/agent-orchestrator/sessions/` |

Broker CLI options:

```bash
node dist/broker/main.js \
  --config .pi/agents.yml \
  --state-dir .pi/agent-orchestrator \
  --port 8787 \
  [--daemon] [--fake-worker] [--help]
```

`--port` overrides the config. `--daemon` is detached-friendly (no terminal assumptions, ignores SIGHUP). `--fake-worker` uses deterministic in-memory workers. The broker writes `broker.json` atomically and refuses to start when an existing descriptor points at a healthy broker for the same project; stale descriptors are removed.

## Security

- The HTTP server, client, and broker refuse non-loopback hosts. Shutdown is accepted only from loopback sockets.
- The broker is shared by all Pi sessions for a project; `/agents stop` or `POST /api/shutdown` shuts it down for everyone.
- Worker output is not exposed over HTTP except as task results/log entries; worker stderr goes to the broker log.
- There is no authentication or RBAC in v1. Do not expose the port through a proxy or tunnel. Config files and broker state may contain prompts and model output; treat them as project data.

## Development

```bash
npm install
npm run check     # tsc --noEmit + vitest (unit + integration)
npm run build     # dist/extension.js, dist/index.js, dist/broker/main.js (+ d.ts)
npm run demo      # built broker + fake workers, full review lifecycle
npm run broker -- --config examples/agents.yml --fake-worker
```

Source layout:

```
src/config.ts        YAML validation, defaults, fingerprint
src/state.ts         pure task transitions and lock rules
src/broker/          scheduler, durable state, event bus, core, CLI
src/server/          loopback HTTP API, SSE, static dashboard
src/worker/          Pi RPC worker adapter and factory
src/models/          model/effort resolution against Pi's catalogue
src/extension/       Pi tools, /agents command, broker autostart
src/client/          typed broker HTTP client
web/                 framework-free dashboard
tests/               unit and end-to-end fake-worker tests
```

Tests cover config validation, recurring schedules, scheduler locking/review/rework/recovery, state persistence, SSE/API/dashboard, model resolution, the RPC adapter, the extension tools/commands/autostart, and a fake-worker end-to-end lifecycle.

## Troubleshooting

**Model not found / unsupported effort.** Startup validates every role before spawning workers. Check the exact model id and provider in your Pi catalogue; use `provider/model`. Effort must be one of the seven levels above, and the model must support the resolved thinking level. Fake-worker mode (`--fake-worker` / `PI_ORCHESTRATOR_FAKE_WORKER=1`) skips model resolution.

**Broker port already in use.** Change `server.port`, pass `--port 0` for an ephemeral port, or stop the other broker with `/agents stop`. If `broker.json` points at a dead or unhealthy process, the broker removes it on the next start; you can also delete `.pi/agent-orchestrator/broker.json`.

**Tools say the broker is unavailable.** Run `/agents start` (or `node dist/broker/main.js --config .pi/agents.yml`) and check `.pi/agent-orchestrator/broker.log`. The extension autostarts the broker only when `.pi/agents.yml` exists and the built broker entry is present (`npm run build`).

**Worker env guard.** Worker processes set `PI_AGENT_ORCHESTRATOR_WORKER=1`; the extension exits immediately in that mode so workers never register orchestrator tools or start nested brokers. If you see recursive broker spawning, check that this variable is present in the spawned Pi process — the RPC adapter sets it automatically.

**A scheduled check keeps being skipped.** This is `overlap: skip` protecting the replica: the previous task is still `queued`, `running` or `awaiting_review`. Close/cancel that task, or set `overlap: queue` if you intentionally want backlog.

**A schedule did not run while the broker was down.** On restart an overdue schedule runs once, then advances past missed intervals. Use `runOnStart: true` for an immediate check on creation/enable, or trigger it manually with `/agents run <id>`.

**A replica is stuck `awaiting_review`.** That is intentional: review the task with `agent_review` (close or rework) or cancel it. Reload is refused while any replica is locked.

**Stale state after a config change.** Restarting with a different config fingerprint retains tasks and logs, records a `config.changed` action, and recreates replicas that no longer match. Delete `.pi/agent-orchestrator/` only when you intentionally want to discard task history.

## Limitations and non-goals

- Loopback only; no remote/multi-host orchestration, cloud hosting, or public exposure.
- The roster is fixed by YAML; no arbitrary agent creation at runtime. Reload or restart after editing the file.
- No rich authentication/RBAC.
- Not a replacement for Pi's built-in orchestrator/subagent systems or a general workflow engine.
- A real-model smoke test is documented but not part of CI; CI uses deterministic fake workers.

## License

MIT
