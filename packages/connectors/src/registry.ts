import type { Connector, ConnectorMode } from "./types";
import { githubLive } from "./github/real";
import { githubSandbox } from "./github/sandbox";
import { slackLive } from "./slack/real";
import { slackSandbox } from "./slack/sandbox";

const CONNECTORS: Connector[] = [githubLive, githubSandbox, slackLive, slackSandbox];

/** Real and sandbox connectors share one interface; the connection's mode picks the implementation. */
export function getConnector(provider: string, mode: ConnectorMode): Connector | undefined {
  return CONNECTORS.find((c) => c.provider === provider && c.mode === mode);
}

/** Providers with working auth + operations. Anything else in the catalog is roadmap. */
export const IMPLEMENTED_PROVIDERS = ["github", "slack"] as const;
