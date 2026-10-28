import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/extension.ts", "src/index.ts", "src/broker/main.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "typebox",
  ],
});
