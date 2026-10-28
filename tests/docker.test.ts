import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

async function read(file: string): Promise<string> {
  return readFile(path.join(root, file), "utf8");
}

describe("Docker Compose packaging", () => {
  it("builds the broker image with a loopback-only published port", async () => {
    const compose = await read("docker-compose.yml");
    expect(compose).toContain("127.0.0.1:${PI_BROKER_PORT:-8787}");
    expect(compose).toContain("PI_ORCHESTRATOR_ALLOW_REMOTE_BIND");
    expect(compose).toContain("PI_ORCHESTRATOR_WORKDIR: /workspace");
    expect(compose).toContain("${PI_PROJECT_DIR:-.}:/workspace");
    expect(compose).toContain("${PI_AGENT_DIR:-${HOME}/.pi/agent}:/root/.pi/agent");
    expect(compose).not.toContain('0.0.0.0:');
  });

  it("keeps workdir/config/state overridable in the image entrypoint", async () => {
    const dockerfile = await read("Dockerfile");
    expect(dockerfile).toContain("PI_ORCHESTRATOR_WORKDIR=/workspace");
    expect(dockerfile).toContain("--workdir");
    expect(dockerfile).toContain("--state-dir");
    expect(dockerfile).toContain("PI_AGENT_CONFIG");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("safe.directory");
  });
});
