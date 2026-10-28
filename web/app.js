/**
 * Pi Agent Orchestrator dashboard.
 *
 * Framework-free. Every value from the broker is rendered with textContent or
 * DOM properties; this file intentionally avoids raw HTML sinks.
 */
const root = document.getElementById("app");

const state = {
  loading: true,
  error: "",
  actionError: "",
  health: null,
  config: null,
  agents: [],
  tasks: [],
  selectedTaskId: null,
  lastSeq: 0,
  sseState: "connecting",
  sse: null,
  pollTimer: null,
  reconnectTimer: null,
  refreshing: false,
  reviewDecision: "close",
  reviewDraft: "",
  submittingReview: false,
  cancellingTaskId: "",
};

const TERMINAL = new Set(["closed", "failed", "cancelled"]);

function el(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value === undefined || value === null) continue;
      node.setAttribute(name, String(value));
    }
  }
  if (options.on) {
    for (const [name, handler] of Object.entries(options.on)) {
      node.addEventListener(name, handler);
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
    } else if (child instanceof Node) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
}

function short(text, max = 140) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function fmtTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDate(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString();
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function escapeStatusLabel(status) {
  return String(status ?? "unknown").replace(/_/g, " ");
}

function statusPill(status) {
  return el("span", {
    class: `pill ${String(status ?? "unknown")}`,
    text: escapeStatusLabel(status),
  });
}

function findTask(taskId) {
  return state.tasks.find((task) => task.id === taskId);
}

function findAgent(agentId) {
  return state.agents.find((agent) => agent.id === agentId);
}

function taskForAgent(agent) {
  if (!agent.currentTaskId) return null;
  return findTask(agent.currentTaskId) ?? null;
}

async function api(path, options = {}) {
  const request = {
    method: options.method || "GET",
    headers: { accept: "application/json" },
  };
  if (options.body !== undefined) {
    request.headers["content-type"] = "application/json";
    request.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, request);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const message =
      (data && data.error && data.error.message) || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
}

async function refreshAll() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const [health, config, agents, tasks] = await Promise.all([
      api("/api/health"),
      api("/api/config"),
      api("/api/agents"),
      api("/api/tasks"),
    ]);
    state.health = health;
    state.config = config;
    state.agents = Array.isArray(agents) ? agents : [];
    state.tasks = Array.isArray(tasks) ? tasks : [];
    state.loading = false;
    state.error = "";
  } catch (error) {
    state.loading = false;
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.refreshing = false;
    render();
  }
}

function connectSSE() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.sse) {
    try {
      state.sse.close();
    } catch {
      // ignore
    }
  }
  if (typeof EventSource === "undefined") {
    state.sseState = "polling";
    startPolling();
    render();
    return;
  }

  const suffix = state.lastSeq > 0 ? `?lastEventId=${encodeURIComponent(state.lastSeq)}` : "";
  const source = new EventSource(`/api/events${suffix}`);
  state.sse = source;
  state.sseState = "connecting";

  source.onopen = () => {
    state.sseState = "live";
    stopPolling();
    render();
  };

  source.onerror = () => {
    state.sseState = "reconnecting";
    startPolling();
    render();
    if (source.readyState === EventSource.CLOSED) {
      scheduleReconnect();
    }
  };

  source.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    handleEvent(event);
  };
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectSSE();
  }, 3000);
}

function handleEvent(event) {
  const seq = Number(event.seq);
  if (Number.isFinite(seq)) {
    if (seq > state.lastSeq + 1 && state.lastSeq > 0) {
      // A gap can happen after a dropped connection. Refetch the full view.
      void refreshAll();
    }
    state.lastSeq = Math.max(state.lastSeq, seq);
  }

  const data = event.data;
  switch (event.type) {
    case "snapshot":
      applySnapshot(data);
      void refreshAll();
      break;
    case "agent.updated":
      if (data && data.agent) upsertAgent(data.agent);
      break;
    case "task.updated":
      if (data && data.task) upsertTask(data.task);
      break;
    case "task.log":
      if (data && data.taskId && data.entry) appendTaskLog(data.taskId, data.entry);
      break;
    case "broker.updated":
      if (data && data.health) state.health = data.health;
      break;
    default:
      return;
  }
  render();
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  if (Array.isArray(snapshot.agents)) {
    state.agents = snapshot.agents.map((agent) => ({
      id: agent.id,
      role: agent.role,
      replica: agent.replica,
      model: agent.config ? agent.config.model : agent.model,
      provider: agent.config ? agent.config.provider : agent.provider,
      effort: agent.config ? agent.config.effort : agent.effort,
      status: agent.status,
      currentTaskId: agent.currentTaskId,
      lastAction: agent.lastAction,
      lastActionAt: agent.lastActionAt,
      pid: agent.pid,
      sessionFile: agent.sessionFile,
      error: agent.error,
      startedAt: agent.startedAt,
      stats: agent.stats,
    }));
  }
  if (Array.isArray(snapshot.tasks)) state.tasks = snapshot.tasks;
}

function upsertAgent(agent) {
  const index = state.agents.findIndex((entry) => entry.id === agent.id);
  if (index >= 0) state.agents[index] = agent;
  else state.agents.push(agent);
}

function upsertTask(task) {
  const index = state.tasks.findIndex((entry) => entry.id === task.id);
  if (index >= 0) state.tasks[index] = task;
  else state.tasks.push(task);
}

function appendTaskLog(taskId, entry) {
  const task = findTask(taskId);
  if (!task) return;
  if (!Array.isArray(task.logs)) task.logs = [];
  task.logs.push(entry);
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => {
    void refreshAll();
  }, 4000);
}

function stopPolling() {
  if (!state.pollTimer) return;
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function selectTask(taskId) {
  state.selectedTaskId = taskId;
  state.reviewDecision = "close";
  state.reviewDraft = "";
  state.actionError = "";
  render();
}

function render() {
  if (!root) return;
  const scrollY = window.scrollY;
  root.replaceChildren();

  root.appendChild(renderTopbar());

  if (state.error) {
    root.appendChild(
      el("div", { class: "banner", attrs: { role: "alert" } }, `Broker error: ${state.error}`),
    );
  }
  if (state.actionError) {
    root.appendChild(
      el(
        "div",
        { class: "banner", attrs: { role: "alert" } },
        `Action failed: ${state.actionError}`,
      ),
    );
  }

  if (state.loading && !state.health) {
    root.appendChild(
      el(
        "section",
        { class: "panel loading", attrs: { "aria-live": "polite" } },
        el("p", { text: "Loading broker dashboard..." }),
      ),
    );
    return;
  }

  root.appendChild(renderStats());

  const layout = el("div", { class: "layout" });
  const left = el("div", { class: "stack" });
  left.appendChild(renderAgents());
  left.appendChild(renderTasks());
  layout.appendChild(left);
  layout.appendChild(renderDetail());
  root.appendChild(layout);

  window.scrollTo(0, scrollY);
  updateElapsed();
}

function renderTopbar() {
  const health = state.health;
  const ok = health ? health.ok : false;
  const uptime = health ? fmtDuration(Date.now() - Date.parse(health.startedAt)) : "-";
  const sseClass =
    state.sseState === "live" ? "ok" : state.sseState === "polling" ? "warn" : "warn";

  const meta = el("div", { class: "topbar-meta" });
  meta.appendChild(
    el(
      "span",
      { class: "chip" },
      el("span", { class: `dot ${ok ? "ok" : "bad"}` }),
      el("strong", { text: health ? (ok ? "healthy" : "degraded") : "unknown" }),
    ),
  );
  meta.appendChild(
    el(
      "span",
      { class: "chip" },
      el("span", { class: `dot ${sseClass}` }),
      el("strong", { text: state.sseState }),
    ),
  );
  if (health) {
    meta.appendChild(
      el(
        "span",
        { class: "chip" },
        "v",
        el("strong", { text: health.version || "-" }),
        el("span", { text: `pid ${health.pid}` }),
      ),
    );
    meta.appendChild(el("span", { class: "chip", text: `uptime ${uptime}` }));
    meta.appendChild(
      el("span", {
        class: "chip",
        text: `config ${String(health.configFingerprint || "").slice(0, 10) || "-"}`,
      }),
    );
  }

  const roles = state.config && state.config.agents ? Object.keys(state.config.agents) : [];
  const replicas = state.agents.length;
  const sub = el(
    "p",
    { class: "sub" },
    `${replicas} replica${replicas === 1 ? "" : "s"} across ${roles.length} role${
      roles.length === 1 ? "" : "s"
    } | events #${state.lastSeq}`,
  );

  return el(
    "header",
    { class: "topbar" },
    el("div", { class: "brand" }, el("h1", { text: "Pi Agent Orchestrator" }), sub),
    meta,
  );
}

function renderStats() {
  const health = state.health;
  if (!health) return el("div", { class: "stats" });
  const stats = el("div", { class: "stats" });
  const add = (label, value, hint) => {
    stats.appendChild(
      el(
        "div",
        { class: "stat" },
        el("div", { class: "label", text: label }),
        el("div", { class: "value", text: String(value) }),
        hint ? el("div", { class: "hint", text: hint }) : null,
      ),
    );
  };
  add(
    "Agents",
    `${health.agents.idle}/${health.agents.total} idle`,
    `${health.agents.busy} busy, ${health.agents.awaitingReview} awaiting review, ${health.agents.error} error`,
  );
  add(
    "Queue",
    health.tasks.queued,
    `${health.tasks.running} running, ${health.tasks.awaitingReview} awaiting review`,
  );
  add("Tasks", health.tasks.total, `${health.tasks.closed} closed, ${health.tasks.failed} failed`);
  add("Cancelled", health.tasks.cancelled, `uptime ${fmtDuration(health.uptimeMs)}`);
  return stats;
}

function renderAgents() {
  const panel = el("section", { class: "panel" });
  panel.appendChild(
    el(
      "div",
      { class: "panel-head" },
      el("h2", { text: "Agents" }),
      el("span", { class: "small muted", text: `${state.agents.length} replicas` }),
    ),
  );

  const body = el("div", { class: "panel-body" });
  if (state.agents.length === 0) {
    body.appendChild(el("p", { class: "empty", text: "No agent replicas are registered." }));
  } else {
    const groups = new Map();
    for (const agent of state.agents) {
      const role = agent.role || "unknown";
      if (!groups.has(role)) groups.set(role, []);
      groups.get(role).push(agent);
    }
    const roles = Array.from(groups.keys()).sort();
    for (const role of roles) {
      const agents = groups.get(role).slice().sort((a, b) => (a.replica || 0) - (b.replica || 0));
      const group = el("div", { class: "role-group" });
      const roleConfig = state.config && state.config.agents ? state.config.agents[role] : null;
      group.appendChild(
        el(
          "div",
          { class: "role-title" },
          el("h3", { text: role }),
          el("span", {
            text: `${agents.length} replica${agents.length === 1 ? "" : "s"}${
              roleConfig ? ` | ${roleConfig.model}` : ""
            }`,
          }),
        ),
      );
      const grid = el("div", { class: "agent-grid" });
      for (const agent of agents) grid.appendChild(renderAgentCard(agent));
      group.appendChild(grid);
      body.appendChild(group);
    }
  }
  panel.appendChild(body);
  return panel;
}

function renderAgentCard(agent) {
  const task = taskForAgent(agent);
  const clickable = Boolean(agent.currentTaskId);
  const card = el("article", {
    class: `agent-card${clickable ? " clickable" : ""}`,
    attrs: clickable
      ? { role: "button", tabindex: "0", "aria-label": `Open task for ${agent.id}` }
      : undefined,
    on: clickable
      ? {
          click: () => selectTask(agent.currentTaskId),
          keydown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              selectTask(agent.currentTaskId);
            }
          },
        }
      : undefined,
  });

  card.appendChild(
    el(
      "div",
      { class: "agent-top" },
      el("span", { class: "agent-id", text: agent.id || `${agent.role}#${agent.replica}` }),
      statusPill(agent.status),
    ),
  );

  const meta = el("div", { class: "agent-meta" });
  meta.appendChild(el("span", { text: agent.model || "-" }));
  if (agent.provider) meta.appendChild(el("span", { text: agent.provider }));
  meta.appendChild(el("span", { text: `effort ${agent.effort || "default"}` }));
  if (agent.pid) meta.appendChild(el("span", { text: `pid ${agent.pid}` }));
  card.appendChild(meta);

  if (task) {
    const started = task.startedAt || task.assignedAt || task.createdAt;
    const taskBox = el(
      "div",
      { class: "agent-task" },
      el("div", { class: "task-title", text: task.title }),
      el("div", { class: "task-sub" }, statusPill(task.status), " ", `${task.role} | attempt ${task.attempts}`),
      el(
        "div",
        { class: "task-sub" },
        el("span", {
          text: "elapsed ",
        }),
        el("span", { attrs: { "data-elapsed": "1", "data-since": started || "" }, text: "-" }),
      ),
    );
    card.appendChild(taskBox);
  } else {
    card.appendChild(
      el(
        "div",
        { class: "agent-task" },
        el("div", { class: "task-sub", text: agent.lastAction || "Waiting for work." }),
      ),
    );
  }

  const logs = task && Array.isArray(task.logs) ? task.logs.slice(-5) : [];
  const actions = el("div", { class: "agent-actions" });
  actions.appendChild(el("div", { class: "label", text: "Last 5 actions" }));
  if (logs.length === 0) {
    actions.appendChild(
      el("div", { class: "task-sub", text: agent.lastAction || "No activity yet." }),
    );
  } else {
    const list = el("ul", { class: "action-list" });
    for (const entry of logs) {
      list.appendChild(
        el(
          "li",
          {},
          el("span", { class: "kind", text: entry.type || "log" }),
          el("span", { text: short(entry.text || "(empty)", 120) }),
        ),
      );
    }
    actions.appendChild(list);
  }
  card.appendChild(actions);

  const latest = latestText(task);
  if (latest) {
    card.appendChild(el("div", { class: "preview", text: latest }));
  }

  return card;
}

function latestText(task) {
  if (!task || !Array.isArray(task.logs)) return "";
  for (let index = task.logs.length - 1; index >= 0; index -= 1) {
    const entry = task.logs[index];
    if (entry && entry.type === "text" && entry.text) return short(entry.text, 320);
  }
  return task.result ? short(task.result, 320) : "";
}

function renderTasks() {
  const panel = el("section", { class: "panel" });
  panel.appendChild(
    el(
      "div",
      { class: "panel-head" },
      el("h2", { text: "Tasks" }),
      el("span", { class: "small muted", text: `${state.tasks.length} total` }),
    ),
  );
  const body = el("div", { class: "panel-body" });
  if (state.tasks.length === 0) {
    body.appendChild(el("p", { class: "empty", text: "No tasks have been submitted." }));
  } else {
    const list = el("div", { class: "task-list" });
    const tasks = state.tasks
      .slice()
      .sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
    for (const task of tasks) {
      list.appendChild(
        el(
          "button",
          {
            class: `task-row${state.selectedTaskId === task.id ? " selected" : ""}`,
            attrs: { type: "button", "aria-pressed": state.selectedTaskId === task.id },
            on: { click: () => selectTask(task.id) },
          },
          el(
            "span",
            {},
            el("span", { class: "title", text: task.title || task.id }),
            el("span", {
              class: "sub",
              text: `${task.role} | ${task.agentId || "unassigned"} | attempt ${
                task.attempts || 0
              } | ${fmtDate(task.createdAt)}`,
            }),
          ),
          statusPill(task.status),
        ),
      );
    }
    body.appendChild(list);
  }
  panel.appendChild(body);
  return panel;
}

function renderDetail() {
  const panel = el("section", { class: "panel detail" });
  const task = findTask(state.selectedTaskId);

  panel.appendChild(
    el(
      "div",
      { class: "panel-head" },
      el("h2", { text: task ? "Task detail" : "Selection" }),
      task
        ? el(
            "button",
            {
              class: "btn",
              attrs: { type: "button" },
              text: "Clear",
              on: { click: () => selectTask(null) },
            },
          )
        : null,
    ),
  );

  const body = el("div", { class: "panel-body detail-body" });
  if (!task) {
    body.appendChild(
      el("p", {
        class: "empty",
        text: "Select an agent or task to inspect its prompt, activity and review controls.",
      }),
    );
    panel.appendChild(body);
    return panel;
  }

  body.appendChild(el("h3", { class: "detail-title", text: task.title || task.id }));

  const grid = el("div", { class: "detail-grid" });
  const cell = (label, value) =>
    el(
      "div",
      { class: "cell" },
      el("div", { class: "detail-label", text: label }),
      el("div", { class: "value", text: value || "-" }),
    );
  grid.appendChild(cell("Status", escapeStatusLabel(task.status)));
  grid.appendChild(cell("Role", task.role));
  grid.appendChild(cell("Agent", task.agentId || "unassigned"));
  grid.appendChild(cell("Attempts", String(task.attempts || 0)));
  grid.appendChild(cell("Created", fmtDate(task.createdAt)));
  grid.appendChild(cell("Started", fmtDate(task.startedAt || task.assignedAt)));
  grid.appendChild(cell("Finished", fmtDate(task.finishedAt)));
  grid.appendChild(
    cell("Elapsed", task.startedAt ? fmtDuration(Date.now() - Date.parse(task.startedAt)) : "-"),
  );
  body.appendChild(grid);

  body.appendChild(
    el(
      "div",
      { class: "section" },
      el("h4", { text: "Prompt" }),
      el("pre", { class: "block", text: task.prompt || "(empty)" }),
    ),
  );

  if (task.acceptance) {
    body.appendChild(
      el(
        "div",
        { class: "section" },
        el("h4", { text: "Acceptance" }),
        el("pre", { class: "block", text: task.acceptance }),
      ),
    );
  }

  if (task.review) {
    body.appendChild(
      el(
        "div",
        { class: "section" },
        el("h4", { text: "Review" }),
        el("pre", {
          class: "block",
          text: `${task.review.decision} at ${fmtDate(task.review.at)} (attempt ${
            task.review.attempt
          })${task.review.feedback ? `\n\n${task.review.feedback}` : ""}`,
        }),
      ),
    );
  }

  body.appendChild(
    el(
      "div",
      { class: "section" },
      el("h4", { text: "Result" }),
      el("pre", { class: "block", text: task.result || "(no result yet)" }),
    ),
  );

  if (task.error) {
    body.appendChild(
      el(
        "div",
        { class: "section" },
        el("h4", { text: "Error" }),
        el("pre", { class: "block", text: task.error }),
      ),
    );
  }

  body.appendChild(renderTimeline(task));

  if (task.status === "awaiting_review") {
    body.appendChild(renderReviewForm(task));
  }

  if (!TERMINAL.has(task.status)) {
    body.appendChild(renderCancelControl(task));
  }

  panel.appendChild(body);
  return panel;
}

function renderTimeline(task) {
  const section = el("div", { class: "section" });
  section.appendChild(el("h4", { text: "Log timeline" }));
  const logs = Array.isArray(task.logs) ? task.logs : [];
  if (logs.length === 0) {
    section.appendChild(el("p", { class: "muted small", text: "No log entries yet." }));
    return section;
  }
  const list = el("ul", { class: "timeline" });
  for (const entry of logs) {
    let text = entry.text || "";
    if (entry.type === "tool_start" && entry.input !== undefined) {
      try {
        text = `${text} ${JSON.stringify(entry.input)}`;
      } catch {
        text = String(text);
      }
    }
    list.appendChild(
      el(
        "li",
        {},
        el("span", { class: "time", text: fmtTime(entry.at) }),
        el("span", { class: `type ${entry.type || ""}`, text: entry.type || "log" }),
        el("span", { class: "text", text: text || "(empty)" }),
      ),
    );
  }
  section.appendChild(list);
  return section;
}

function renderReviewForm(task) {
  const form = el("form", { class: "review-form" });
  form.appendChild(el("h4", { text: "Review this result" }));

  const row = el("div", { class: "row" });
  const makeOption = (value, label) => {
    const input = el("input", {
      attrs: {
        type: "radio",
        name: "decision",
        value,
        ...(state.reviewDecision === value ? { checked: "checked" } : {}),
      },
      on: {
        change: () => {
          if (state.reviewDecision !== value) {
            state.reviewDecision = value;
            render();
          }
        },
      },
    });
    return el("label", {}, input, label);
  };
  row.appendChild(makeOption("close", "Close (accept)"));
  row.appendChild(makeOption("rework", "Rework (keep context)"));
  form.appendChild(row);

  const textarea = el("textarea", {
    attrs: {
      placeholder: "Feedback required for rework. Explain exactly what must change.",
      "aria-label": "Review feedback",
    },
    on: {
      input: (event) => {
        state.reviewDraft = event.target.value;
      },
    },
  });
  textarea.value = state.reviewDraft;
  if (state.reviewDecision !== "rework") textarea.disabled = true;
  form.appendChild(textarea);

  const submit = el("button", {
    class: "btn primary",
    attrs: { type: "submit", disabled: state.submittingReview ? "disabled" : undefined },
    text: state.submittingReview ? "Submitting..." : "Submit review",
  });
  form.appendChild(submit);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitReview(task.id);
  });
  return form;
}

async function submitReview(taskId) {
  if (state.submittingReview) return;
  const decision = state.reviewDecision;
  const feedback = state.reviewDraft.trim();
  if (decision === "rework" && !feedback) {
    state.actionError = "Rework requires non-empty feedback.";
    render();
    return;
  }
  state.submittingReview = true;
  state.actionError = "";
  render();
  try {
    const updated = await api(`/api/tasks/${encodeURIComponent(taskId)}/review`, {
      method: "POST",
      body: decision === "rework" ? { decision, feedback } : { decision },
    });
    upsertTask(updated);
    state.reviewDraft = "";
    state.reviewDecision = "close";
    selectTask(taskId);
    void refreshAll();
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    state.submittingReview = false;
    render();
  }
}

function renderCancelControl(task) {
  const wrapper = el("div", { class: "row" });
  const button = el("button", {
    class: "btn danger",
    attrs: {
      type: "button",
      disabled: state.cancellingTaskId === task.id ? "disabled" : undefined,
    },
    text: state.cancellingTaskId === task.id ? "Cancelling..." : "Cancel task",
    on: {
      click: () => {
        void cancelTask(task.id);
      },
    },
  });
  wrapper.appendChild(button);
  return wrapper;
}

async function cancelTask(taskId) {
  if (state.cancellingTaskId) return;
  state.cancellingTaskId = taskId;
  state.actionError = "";
  render();
  try {
    const updated = await api(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
    });
    upsertTask(updated);
    void refreshAll();
  } catch (error) {
    state.actionError = error instanceof Error ? error.message : String(error);
  } finally {
    state.cancellingTaskId = "";
    render();
  }
}

function updateElapsed() {
  const now = Date.now();
  const nodes = document.querySelectorAll("[data-elapsed]");
  for (const node of nodes) {
    const since = node.getAttribute("data-since");
    if (!since) {
      node.textContent = "-";
      continue;
    }
    const parsed = Date.parse(since);
    node.textContent = Number.isFinite(parsed) ? fmtDuration(now - parsed) : "-";
  }
}

render();
void refreshAll();
connectSSE();
setInterval(updateElapsed, 1000);
