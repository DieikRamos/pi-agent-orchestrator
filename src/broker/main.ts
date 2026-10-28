#!/usr/bin/env node
import { pathToFileURL } from "node:url";

/**
 * Broker CLI entry point.
 *
 * The broker runtime node implements the HTTP server, scheduler and worker
 * pool. This scaffold keeps the build entry stable.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  void argv;
  console.error(
    "pi-agent-orchestrator broker is not implemented in the contract scaffold.",
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
