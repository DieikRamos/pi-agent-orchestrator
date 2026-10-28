import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi extension entry point.
 *
 * The contract/scaffold node deliberately registers no tools yet. The extension
 * node replaces this factory with the dispatch/status/wait/review/cancel tools
 * and slash commands. The broker must never be started recursively inside a
 * worker process (`PI_AGENT_ORCHESTRATOR_WORKER=1`).
 */
export default function piAgentOrchestrator(_pi: ExtensionAPI): void {
  // Intentionally empty: tools and commands are registered by the extension node.
}
