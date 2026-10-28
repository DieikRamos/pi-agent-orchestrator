import { describe, expect, it } from "vitest";

import {
  ModelResolutionError,
  ModelRuntimeResolver,
  ThinkingLevelError,
  assertThinkingLevelSupported,
  createModelResolver,
  isThinkingLevelSupported,
  resolveThinkingLevel,
  resolveConfigModels,
  supportedThinkingLevels,
  type CatalogModel,
  type ModelCatalog,
} from "../../src/models/resolve.js";
import type { AgentConfig } from "../../src/types.js";

function model(
  provider: string,
  id: string,
  extra: Partial<CatalogModel> = {},
): CatalogModel {
  return { provider, id, name: id, ...extra };
}

class FakeCatalog implements ModelCatalog {
  readonly all: CatalogModel[];
  readonly available: CatalogModel[];

  constructor(all: CatalogModel[], available: CatalogModel[] = all) {
    this.all = all;
    this.available = available;
  }

  getModels(provider?: string): readonly CatalogModel[] {
    return provider === undefined
      ? this.all
      : this.all.filter((item) => item.provider.toLowerCase() === provider.toLowerCase());
  }

  getAvailable(provider?: string): Promise<readonly CatalogModel[]> {
    return Promise.resolve(this.getModels(provider).filter((item) => this.available.includes(item)));
  }
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    role: "developer",
    description: "Implement assigned work.",
    model: "anthropic/claude-sonnet-4-5",
    replicas: 1,
    ...overrides,
  };
}

const CATALOG = new FakeCatalog([
  model("anthropic", "claude-sonnet-4-5", { name: "Claude Sonnet 4.5", reasoning: true }),
  model("anthropic", "claude-haiku-4-5", { name: "Claude Haiku 4.5", reasoning: true }),
  model("openai", "gpt-5", { name: "GPT-5", reasoning: true }),
  model("openrouter", "meta/llama-3.3-70b", { name: "Llama 3.3 70B", reasoning: false }),
  model("deepseek", "deepseek-chat", { name: "DeepSeek Chat", reasoning: true }),
  model("fake", "plain-model", { name: "Plain Model", reasoning: false }),
]);

describe("model resolution", () => {
  it("resolves an exact provider/model spec and normalizes the provider", async () => {
    const resolver = new ModelRuntimeResolver(CATALOG);
    await expect(
      resolver.resolve(agent({ model: "Anthropic/claude-sonnet-4-5", provider: "Anthropic" })),
    ).resolves.toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  it("resolves a unique bare id or display pattern", async () => {
    const resolver = new ModelRuntimeResolver(CATALOG);
    await expect(resolver.resolve(agent({ model: "deepseek" }))).resolves.toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
    });
    await expect(resolver.resolve(agent({ model: "Sonnet 4.5" }))).resolves.toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    await expect(resolver.resolve(agent({ model: "claude-*haiku*" }))).resolves.toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("splits provider on the first slash only", async () => {
    const resolver = new ModelRuntimeResolver(CATALOG);
    await expect(resolver.resolve(agent({ model: "openrouter/meta/llama-3.3-70b" }))).resolves.toEqual({
      provider: "openrouter",
      model: "meta/llama-3.3-70b",
    });
  });

  it("rejects conflicting explicit and spec providers", async () => {
    const resolver = new ModelRuntimeResolver(CATALOG);
    await expect(
      resolver.resolve(agent({ model: "anthropic/claude-sonnet-4-5", provider: "openai" })),
    ).rejects.toThrow(/names provider "anthropic" but agent\.provider is "openai"/);
  });

  it("reports ambiguous matches with candidates and a fix", async () => {
    const catalog = new FakeCatalog([
      ...CATALOG.all,
      model("other", "claude-sonnet-4-5", { name: "Claude Sonnet 4.5 clone" }),
    ]);
    const resolver = new ModelRuntimeResolver(catalog);
    const error = await resolver.resolve(agent({ model: "claude-sonnet-4-5" })).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ModelResolutionError);
    expect((error as ModelResolutionError).candidates).toEqual([
      "anthropic/claude-sonnet-4-5",
      "other/claude-sonnet-4-5",
    ]);
    expect((error as Error).message).toMatch(/ambiguous/);
    expect((error as Error).message).toMatch(/provider\/model/);
  });

  it("reports missing models and lists known providers", async () => {
    const resolver = new ModelRuntimeResolver(CATALOG);
    const error = await resolver.resolve(agent({ model: "nope-9000" })).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ModelResolutionError);
    expect((error as Error).message).toMatch(/was not found/);
    expect((error as Error).message).toMatch(/Known providers: .*anthropic/);
    expect((error as ModelResolutionError).candidates.length).toBeGreaterThan(0);
  });

  it("distinguishes an unavailable model from a missing model", async () => {
    const unavailable = model("anthropic", "claude-opus-4-5", {
      name: "Claude Opus 4.5",
      reasoning: true,
    });
    const catalog = new FakeCatalog([...CATALOG.all, unavailable], CATALOG.all);
    const resolver = new ModelRuntimeResolver(catalog);
    const error = await resolver.resolve(agent({ model: "claude-opus-4-5" })).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ModelResolutionError);
    expect((error as Error).message).toMatch(/none are available/);
    expect((error as Error).message).toMatch(/pi auth/);
    expect((error as ModelResolutionError).candidates).toContain("anthropic/claude-opus-4-5");
  });

  it("resolves thinking levels case-insensitively with a medium default", async () => {
    const resolver = new ModelRuntimeResolver(CATALOG);
    await expect(
      resolver.resolveWithThinking(agent({ model: "gpt-5", effort: "HIGH" as never })),
    ).resolves.toMatchObject({ provider: "openai", model: "gpt-5", thinkingLevel: "high" });
    await expect(resolver.resolveWithThinking(agent({ model: "gpt-5" }))).resolves.toMatchObject({
      thinkingLevel: "medium",
    });
    await expect(
      resolver.resolveWithThinking(agent({ model: "openrouter/meta/llama-3.3-70b" })),
    ).resolves.toMatchObject({ thinkingLevel: "off" });
  });

  it("rejects invalid efforts and unsupported model levels", async () => {
    const resolver = new ModelRuntimeResolver(CATALOG);
    await expect(
      resolver.resolveWithThinking(agent({ model: "gpt-5", effort: "extreme" as never })),
    ).rejects.toThrow(/invalid effort "extreme"/);

    const error = await resolver
      .resolveWithThinking(agent({ model: "openrouter/meta/llama-3.3-70b", effort: "high" }))
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ThinkingLevelError);
    expect((error as Error).message).toMatch(/not supported by model openrouter\/meta\/llama-3.3-70b/);
    expect((error as ThinkingLevelError).supported).toEqual(["off"]);
  });

  it("honours thinkingLevelMap null entries and available-level validation", async () => {
    const mapped = model("anthropic", "claude-mapped", {
      reasoning: true,
      thinkingLevelMap: { low: null, high: "max" },
    });
    const catalog = new FakeCatalog([...CATALOG.all, mapped]);
    const resolver = new ModelRuntimeResolver(catalog);

    await expect(
      resolver.resolveWithThinking(agent({ model: "claude-mapped", effort: "high" })),
    ).resolves.toMatchObject({ thinkingLevel: "high" });
    await expect(
      resolver.resolveWithThinking(agent({ model: "claude-mapped", effort: "low" })),
    ).rejects.toThrow(/supported levels: off, minimal, medium, high, xhigh, max/);

    await expect(
      resolver.resolveWithThinking(agent({ model: "gpt-5", effort: "xhigh" }), {
        availableThinkingLevels: ["off", "low", "medium", "high"],
      }),
    ).rejects.toThrow(/thinking level "xhigh" is not available/);

    expect(isThinkingLevelSupported(mapped, "low")).toBe(false);
    expect(supportedThinkingLevels(mapped)).not.toContain("low");
    expect(resolveThinkingLevel("MAX")).toBe("max");
    expect(() => assertThinkingLevelSupported(mapped, "low")).toThrow(ThinkingLevelError);
  });

  it("validates every role before returning a resolved map", async () => {
    const resolver = new ModelRuntimeResolver(CATALOG);
    const resolved = await resolveConfigModels(resolver, [
      agent({ role: "developer" }),
      agent({ role: "reviewer", model: "gpt-5", effort: "low" }),
    ]);
    expect([...resolved.keys()]).toEqual(["developer", "reviewer"]);
    expect(resolved.get("reviewer")?.thinkingLevel).toBe("low");
  });

  it("createModelResolver accepts an injected catalogue", async () => {
    const resolver = await createModelResolver({ runtime: CATALOG });
    await expect(resolver.resolve(agent())).resolves.toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });
});
