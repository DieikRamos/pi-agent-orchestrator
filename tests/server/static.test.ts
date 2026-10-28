import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveWebRoot, webRootCandidates } from "../../src/server/http.js";

describe("static asset resolution", () => {
  it("resolves web/ relative to import.meta.url", () => {
    const expected = path.resolve(fileURLToPath(new URL("../../web/", import.meta.url)));
    expect(resolveWebRoot()).toBe(expected);
  });

  it("treats an import.meta.url string as a URL, not a cwd-relative path", () => {
    const modulePath = path.join(path.sep, "opt", "pkg", "dist", "server", "http.js");
    const moduleUrl = pathToFileURL(modulePath);
    const expected = path.join(path.sep, "opt", "pkg", "web");
    expect(webRootCandidates(moduleUrl.href)[0]).toBe(expected);
    expect(webRootCandidates(moduleUrl)[0]).toBe(expected);
    expect(webRootCandidates(modulePath)[0]).toBe(expected);
  });

  it("prefers an explicit web root and falls back gracefully", () => {
    const expected = path.resolve(fileURLToPath(new URL("../../web/", import.meta.url)));
    expect(resolveWebRoot(expected)).toBe(expected);
    expect(resolveWebRoot("/definitely/not/a/real/dashboard")).toBe(expected);
  });
});
