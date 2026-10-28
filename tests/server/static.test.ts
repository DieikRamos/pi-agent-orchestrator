import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveWebRoot } from "../../src/server/http.js";

describe("static asset resolution", () => {
  it("resolves web/ relative to import.meta.url", () => {
    const expected = path.resolve(fileURLToPath(new URL("../../web/", import.meta.url)));
    expect(resolveWebRoot()).toBe(expected);
  });

  it("prefers an explicit web root and falls back gracefully", () => {
    const expected = path.resolve(fileURLToPath(new URL("../../web/", import.meta.url)));
    expect(resolveWebRoot(expected)).toBe(expected);
    expect(resolveWebRoot("/definitely/not/a/real/dashboard")).toBe(expected);
  });
});
