import assert from "node:assert/strict";
import { dashboardStatus, shouldLogHttpRequest } from "./server.js";
import type { ServerConfig } from "./config.js";
import { InteractionLog } from "./interaction-log.js";

const config: ServerConfig = {
  host: "127.0.0.1",
  port: 7676,
  oauth: {
    ownerToken: "test-owner-token-that-is-long-enough",
    scopes: ["devspace"],
    allowedRedirectHosts: ["chatgpt.com", "localhost"],
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 2_592_000,
  },
  allowedRoots: [process.cwd()],
  allowedHosts: ["localhost", "127.0.0.1", "::1", "latest.taildea223.ts.net"],
  publicBaseUrl: "https://latest.taildea223.ts.net",
  minimalTools: true,
  toolNaming: "short",
  widgets: "full",
  stateDir: process.cwd(),
  worktreeRoot: process.cwd(),
  skillsEnabled: true,
  skillPaths: [],
  agentDir: process.cwd(),
  logging: {
    level: "info",
    format: "json",
    requests: true,
    assets: false,
    toolCalls: true,
    shellCommands: false,
    trustProxy: false,
  },
};

const interactions = new InteractionLog();
const status = dashboardStatus(config, 2, interactions) as {
  server: {
    publicBaseUrl: string;
    publicMcpUrl: string;
    activeMcpSessions: number;
  };
  access: {
    oauthOwnerToken: string;
    oauthScopes: string[];
  };
};

assert.equal(status.server.publicBaseUrl, "https://latest.taildea223.ts.net");
assert.equal(status.server.publicMcpUrl, "https://latest.taildea223.ts.net/mcp");
assert.equal(status.server.activeMcpSessions, 2);
assert.equal(status.access.oauthOwnerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(status.access.oauthScopes, ["devspace"]);

assert.equal(shouldLogHttpRequest(config, "/app/status"), false);
assert.equal(shouldLogHttpRequest(config, "/app/interactions"), true);
assert.equal(shouldLogHttpRequest(config, "/mcp-app-assets/dashboard.js"), false);
