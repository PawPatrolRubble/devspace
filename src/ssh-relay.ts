import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { expandHomePath } from "./roots.js";

export interface SshRelayConfig {
  host: string;
  user: string;
  sshPort?: number;
  remotePort?: number;
  identityFile?: string;
}

export interface SshRelayOptions {
  host: string;
  user: string;
  sshPort: number;
  remotePort: number;
  localPort: number;
  identityFile?: string;
}

export interface SshRelayController {
  stop(): void;
}

export interface SshRelayDependencies {
  spawnProcess?: typeof spawn;
  onEvent?: (message: string) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export function resolveSshRelayOptions(
  config: SshRelayConfig | undefined,
  localPort: number,
): SshRelayOptions {
  if (!config) {
    throw new Error("SSH relay is not configured. Add relay.host and relay.user to ~/.devspace/config.json.");
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(config.user)) {
    throw new Error("relay.user must be a valid SSH account name.");
  }
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,251}[a-zA-Z0-9])?$/.test(config.host) ||
      config.host.includes("..")) {
    throw new Error("relay.host must be a DNS name or IPv4 address without a port.");
  }
  const sshPort = config.sshPort ?? 22;
  const remotePort = config.remotePort ?? 17676;
  if (!isPort(sshPort) || !isPort(localPort) || !isPort(remotePort) || remotePort < 1024) {
    throw new Error("SSH/local ports must be 1-65535; relay.remotePort must be >= 1024.");
  }
  if (config.identityFile !== undefined && !config.identityFile.trim()) {
    throw new Error("relay.identityFile cannot be empty.");
  }
  return {
    host: config.host,
    user: config.user,
    sshPort,
    remotePort,
    localPort,
    ...(config.identityFile ? { identityFile: resolve(expandHomePath(config.identityFile)) } : {}),
  };
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function sshRelayArguments(options: SshRelayOptions): string[] {
  const args = [
    "-N", "-T",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=10",
    "-o", "NumberOfPasswordPrompts=0",
    "-p", String(options.sshPort),
  ];
  if (options.identityFile) {
    args.push("-i", options.identityFile, "-o", "IdentitiesOnly=yes");
  }
  args.push(
    "-R",
    "127.0.0.1:" + options.remotePort + ":127.0.0.1:" + options.localPort,
    options.user + "@" + options.host,
  );
  return args;
}

/** Start an SSH reverse tunnel and reconnect on disconnection with bounded backoff. */
export function startSshRelay(
  options: SshRelayOptions,
  dependencies: SshRelayDependencies = {},
): SshRelayController {
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const notify = dependencies.onEvent ?? (() => {});
  const retryBase = dependencies.retryBaseMs ?? 1_000;
  const retryMax = dependencies.retryMaxMs ?? 30_000;
  if (retryBase < 1 || retryMax < retryBase) {
    throw new Error("Invalid SSH relay retry intervals.");
  }

  let stopped = false;
  let active: ChildProcess | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;
  let startedAt = 0;

  const scheduleReconnect = (): void => {
    if (stopped || retryTimer) return;
    const delay = Math.min(retryMax, retryBase * 2 ** Math.min(consecutiveFailures, 12));
    consecutiveFailures++;
    notify("SSH relay disconnected; retrying in " + delay + "ms.");
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (stopped || active) return;
    let child: ChildProcess;
    try {
      child = spawnProcess("ssh", sshRelayArguments(options), {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      notify("SSH relay could not start: " + String(error));
      scheduleReconnect();
      return;
    }
    active = child;
    startedAt = Date.now();
    notify("SSH relay process started for " + options.user + "@" + options.host +
      " (remote port " + options.remotePort + ").");

    child.stderr?.on("data", (data: Buffer | string) => {
      const message = String(data).trim();
      if (message) notify("SSH: " + message.slice(0, 1500));
    });
    child.on("error", (error: Error) => {
      if (active !== child || stopped) return;
      notify("SSH relay error: " + error.message);
      active = undefined;
      scheduleReconnect();
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (active !== child || stopped) return;
      active = undefined;
      if (Date.now() - startedAt >= 60_000) consecutiveFailures = 0;
      notify("SSH relay exited (code=" + (code ?? "unknown") +
        ", signal=" + (signal ?? "none") + ").");
      scheduleReconnect();
    });
  };

  connect();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      const child = active;
      active = undefined;
      child?.kill();
    },
  };
}
