import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../../web/", import.meta.url));

async function readWeb(file: string): Promise<string> {
  return readFile(new URL(file, `file://${webRoot}`), "utf8");
}

describe("dashboard smoke checks", () => {
  it("index.html references the local app and stylesheet", async () => {
    const html = await readWeb("index.html");
    expect(html).toContain('href="/styles.css"');
    expect(html).toContain('src="/app.js"');
    expect(html).toContain("Pi Agent Orchestrator");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
  });

  it("app.js implements SSE, reconnect, review and cancel handlers without raw HTML sinks", async () => {
    const app = await readWeb("app.js");
    expect(app).toContain("new EventSource");
    expect(app).toContain("lastEventId");
    expect(app).toContain("scheduleReconnect");
    expect(app).toContain("onerror");
    expect(app).toContain("/api/events");
    expect(app).toContain("/api/tasks/");
    expect(app).toContain("/review");
    expect(app).toContain("/cancel");
    expect(app).toContain("submitReview");
    expect(app).toContain("cancelTask");
    expect(app).toContain("/api/schedules/");
    expect(app).toContain("runScheduleNow");
    expect(app).toContain("toggleSchedule");
    expect(app).toContain("startPolling");
    expect(app).not.toContain(".innerHTML");
    expect(app).toContain("textContent");
  });

  it("styles.css provides responsive agent cards and status pills", async () => {
    const css = await readWeb("styles.css");
    expect(css).toContain(".agent-card");
    expect(css).toContain(".pill.awaiting_review");
    expect(css).toContain(".schedule-card");
    expect(css).toContain("@media (max-width: 1040px)");
    expect(css).toContain("@media (max-width: 620px)");
    expect(css).not.toMatch(/@import\s+url\(/);
  });
});
