> **Historical note:** this report covers the initial implementation before recurring schedules were added. The current test suite is 164 tests; schedule behavior is covered by `tests/config.test.ts`, `tests/broker/scheduler.test.ts`, `tests/broker/core.test.ts`, `tests/server/http.test.ts`, and extension/client tests.

# Verification report — pi-agent-orchestrator

**Verdict: PASS** for all required local checks. Real-model smoke: **NOT RUN** (gated test was not requested by the environment; no model tokens were spent).

- Repository: `/Users/user/Projects/pi-agent-orchestrator`
- Commit verified: `46ff4a9` (`fix: verification defects`)
- Environment: macOS Darwin x86_64, Node `v26.7.0`, npm `11.19.0`, Pi `1.4.0`
- Verification date: 2026-10-28

## Requirement results

| # | Requirement | Result | Evidence |
|---|---|---|---|
| 1 | Clean install, typecheck/tests, build | **PASS** | `npm ci`, `npm run check` (19 files / 164 tests), `npm run build` all exited 0 |
| 2 | Config and model/effort validation | **PASS** | `tests/config.test.ts` (22 tests), `tests/models/resolve.test.ts` (12 tests); fake catalogue, no network |
| 3 | Built fake-worker broker over HTTP/SSE | **PASS** | Independent verifier: 47/47 checks; queueing, locking, rework, close/reset, cancel, failure, persistence, recovery, SSE, dashboard, loopback |
| 4 | Extension registration and worker guard | **PASS** | Mock `ExtensionAPI` check against `dist/extension.js`; Guard registers nothing when `PI_AGENT_ORCHESTRATOR_WORKER=1` |
| 5 | Real RPC adapter | **PASS** (unit), real smoke **NOT RUN** | `tests/worker/rpc-worker.test.ts` (16 tests), `tests/worker/factory.test.ts` (8 tests); env `PI_ORCHESTRATOR_REAL_SMOKE` was unset |
| 6 | Security and robustness | **PASS** | Loopback listener observed; 413 body limit; no raw HTML sinks; no shell interpolation; stale descriptor, graceful shutdown, timeout/abort covered |
| 7 | Package contents/manifest | **PASS** | `npm pack --dry-run` includes `dist`, `web`, `docs`, `examples`, `scripts`, README; runtime dependency is only `yaml` |

## Exact commands and key outputs

### Install, check, build

```bash
rm -rf node_modules
npm ci
# exited 0 (lockfile present); npm reported 8 audit advisories in the dev tree

npm run check
# tsc --noEmit exited 0
# Test Files  19 passed (19)
# Tests       164 passed (164)

npm run build
# tsup emitted dist/extension.js, dist/index.js, dist/broker/main.js and .d.ts files
# ESM Build success, DTS Build success
```

The clean install used `npm ci` because `package-lock.json` exists. `npm install &&
npm run check && npm run build` is therefore satisfied by the lockfile path.

### Demo

```bash
npm run demo
# Broker ready on an ephemeral loopback port, 5 replicas.
# Three tasks routed, two replicas held awaiting review.
# Backend rework kept epoch 1; closing reset replicas; final pool idle; exit 0.
```

### Independent end-to-end fake-worker verification

Verifier script (kept under the run artifacts, not packaged):
`.pi/orchestrator/runs/20261028112218-plan-1-452b9d09/nodes/verify/e2e-verify.mjs`

```bash
node .pi/orchestrator/runs/20261028112218-plan-1-452b9d09/nodes/verify/e2e-verify.mjs
# 47/47 checks passed, 0 failed
```

It starts the built CLI in a temporary project and state directory with
`--port 0 --fake-worker --daemon`, `PI_ORCHESTRATOR_FAKE_WORKER=1`, and the
packaged dashboard. Key observed results:

- Initial SSE frame was `snapshot`; `/api/health`, `/api/agents`, `/api/tasks`
  were consistent; two replicas started `idle` and unlocked.
- Dashboard `/`, `/app.js`, `/styles.css` returned 200; `app.js` references
  `EventSource`, `/api/events`, `/review`, `rework`; no raw HTML sinks.
- Listener was `127.0.0.1:<port>` only (`lsof`), never `0.0.0.0`.
- Three tasks for a two-replica role: two reached `awaiting_review` with
  `currentTaskId` set, the third stayed `queued` with no agent. SSE showed two
  distinct tasks in `running`, plus `agent.updated`, `task.updated`, `task.log`.
- Rework stayed on the same replica and same fake epoch (`1 -> 1`), recorded
  feedback, and returned to review with attempt 2.
- Close released the replica, reset context (`1 -> 2`), and immediately
  dispatched the queued task.
- Cancel released a locked replica and reset context (`1 -> 2`) before reuse.
- Request body over 1 MiB produced `413 payload_too_large`; unknown role
  produced `400 invalid_request`.
- Real `SIGKILL` left a stale `broker.json`; restart replaced it, preserved all
  nine tasks exactly once, kept two review locks and three queued tasks, and did
  not duplicate dispatch. Closing a recovered review dispatched queued work.
- Graceful `POST /api/shutdown` exited with code 0 and removed `broker.json`.
- Worker failure scenario (built `BrokerCore` + built HTTP server with an
  injected fake failure): task became `failed` with `injected failure`; replica
  returned to `idle` and reset epoch to 2; the next task ran on the same replica
  in epoch 2.
- Seeded interrupted state (`running`/`assigned` tasks persisted by a prior
  process) was marked `failed` with `broker_restarted`; queued and
  `awaiting_review` tasks and locks survived without duplication.

### Config and model coverage

```bash
npx vitest run tests/config.test.ts tests/models/resolve.test.ts
# 34 tests passed (part of the full 151)
```

Covered: sample/minimal config, invalid YAML parse error, unknown keys,
`x-*` annotations, duplicate roles, replica bounds 1–16, effort case
normalization and invalid effort, missing required fields, loopback host
rejection, fingerprint order independence, `parseModelSpec` first-slash split,
ambiguous model error, missing model error, unavailable-credential distinction,
thinking-level map/unsupported effort, and injected fake catalogue resolution
(no network).

### Extension smoke

```bash
node --input-type=module -e '...mock ExtensionAPI...'
# tools: agent_dispatch, agent_wait, agent_status, agent_review, agent_cancel
# command: agents
# lifecycle events: session_start, session_shutdown
# with PI_AGENT_ORCHESTRATOR_WORKER=1: no tools, commands or handlers
```

```bash
pi --version
# 1.4.0

pi --offline --no-mcp --list-models -e ./dist/extension.js
# exit 0; extension loaded; model catalogue listed
# No model prompt was sent and no model tokens were spent.
```

### Real RPC adapter evidence

- `buildRpcOptions` passes `--mode rpc`, `--session-dir <state>/sessions`,
  `--offline`, and role tools. `provider`/`model` are passed through
  `RpcClientOptions`; Pi's `RpcClient` adds `--provider` and `--model` to the
  spawned argv.
- Worker env includes `PI_AGENT_ORCHESTRATOR_WORKER=1`, so a worker never
  registers extension tools or starts a nested broker.
- `start()` applies the resolved thinking level after checking the levels
  reported by the running RPC client.
- `reset()` calls `newSession()` and verifies the session changed or is empty;
  rework uses `feedback()` without `newSession`. The scheduler calls reset on
  close/cancel/failure before redispatch.
- Unit tests cover start, thinking level, events, errors, timeout/abort, reset,
  feedback, stop, and process-exit diagnostics. `tests/worker/factory.test.ts`
  asserts the required argv and env.
- Real-model smoke: **NOT RUN**. `PI_ORCHESTRATOR_REAL_SMOKE` was unset; no
  real-model result is claimed.

### Package

```bash
npm pack --dry-run
# 24 files, 171.2 kB packed
# includes dist/*, web/*, docs/contracts.md, docs/verification-report.md,
# examples/agents.yml, scripts/demo.mjs, README.md, package.json
```

`package.json` declares `pi.extensions: ["./dist/extension.js"]`,
`main: "./dist/extension.js"`, and a `pi-agent-orchestrator` bin. Runtime
`dependencies` contains only `yaml`; Pi packages and `typebox` are
peer dependencies. `dist/extension.js` exists after build.

## Defect found and fixed

**Dashboard assets returned 503 when the broker ran outside the package root.**

- Cause: `webRootCandidates()` treated `import.meta.url` as a filesystem path
  because it is a string. `path.resolve("file:///...")` produced a cwd-prefixed
  bogus path, so the packaged `web/` directory was missed unless the process
  happened to run from the repository root.
- Fix: URL strings are now parsed as URLs; plain paths and `URL` objects still
  work. Added a regression test in `tests/server/static.test.ts`.
- Verification: the independent built-broker run initially returned 503 for
  `/`, `/app.js`, `/styles.css`; after the fix all returned 200.
- Commit: `46ff4a9 fix: verification defects` (two files, +19/−3).

## Residual issues (non-blocking)

- **Real-model smoke not run.** Optional by contract; needs
  `PI_ORCHESTRATOR_REAL_SMOKE=1` plus valid provider credentials.
- **Recovery of in-flight tasks** was exercised by seeding a persisted
  `running`/`assigned` state, because fake workers complete synchronously and
  cannot be held in-flight from the CLI. Real `SIGKILL` was exercised separately
  with queued and awaiting-review work; no duplicate dispatch occurred.
- **Worker failure over HTTP** used the built `BrokerCore` + built HTTP server
  with an injected fake failure (the fake-worker CLI mode has no failure-injection
  environment switch). The CLI path is covered for all other lifecycle steps.
- `broker.updated` is declared in the SSE type union and contracts but is not
  currently emitted by the scheduler; the dashboard refreshes health via HTTP.
  This does not affect the required agent/task SSE updates.
- The HTTP SSE endpoint always starts with a snapshot; the documented
  `Last-Event-ID` replay buffer exists in `EventBus` but is not consumed by the
  route. Reconnecting clients still converge through the snapshot.
- `npm ci` reports audit advisories in the development dependency tree. No
  production runtime dependency other than `yaml`; advisories were not
  remediated because that would change unrelated dependency versions.
- The published tarball intentionally contains built `dist` output rather than
  `src`; source is available from the repository.

## Rollback

Only one source change was required for verification:

```bash
git revert 46ff4a9
```

No config, state schema, or dependency changes were made. The verification
script lives under the run artifacts directory and is not part of the package.
Deleting `.pi/agent-orchestrator/` in a project is only necessary to discard
intentional local task history, not to roll back this change.
