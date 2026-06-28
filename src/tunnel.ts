import { execFile, type ExecFileException } from "node:child_process";
import { platform } from "node:os";

type ExecFileCallback = (error: ExecFileException | null, stdout: string, stderr: string) => void;

type ExecFileProcessWithCallback = (
  command: string,
  args: string[],
  options: {
    encoding: "utf8";
    timeout: number;
    windowsHide: boolean;
  },
  callback: ExecFileCallback,
) => void;

export interface TunnelResult {
  /** The captured public tunnel URL (e.g. https://machine.tailnet.ts.net) */
  url: string;
}

/**
 * Configures Tailscale Funnel in the background and resolves with the public URL.
 *
 * Equivalent to running: tailscale funnel --bg --yes {port}
 */
export async function startTailscaleFunnel(
  port: number,
  timeoutMs = 30_000,
  execFileProcess: ExecFileProcessWithCallback = execFile,
): Promise<TunnelResult> {
  const runner = createTailscaleRunner(execFileProcess, timeoutMs);
  await runner(["funnel", "--bg", "--yes", String(port)]);

  const status = await runner(["funnel", "status", "--json"]);
  const url = extractTailscaleFunnelUrl(status.stdout);
  if (!url) {
    throw new Error("Tailscale Funnel did not report a public URL. Run `tailscale funnel status` to inspect it.");
  }

  return { url };
}

function createTailscaleRunner(execFileProcess: ExecFileProcessWithCallback, timeoutMs: number) {
  return async (args: string[]): Promise<{ stdout: string; stderr: string }> => {
    const bins = tailscaleBins();
    let lastError: Error | null = null;

    for (const bin of bins) {
      try {
        return await runCommand(execFileProcess, bin, args, timeoutMs);
      } catch (error) {
        if (!isMissingExecutableError(error)) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(
      "tailscale is not installed or not on PATH. Install Tailscale or add tailscale.exe to PATH." +
        (lastError ? `\n${lastError.message}` : ""),
    );
  };
}

function runCommand(
  execFileProcess: ExecFileProcessWithCallback,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileProcess(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const details = stderr.trim();
        reject(new Error(details ? `${error.message}\n${details}` : error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function tailscaleBins(): string[] {
  if (platform() !== "win32") return ["tailscale"];
  return ["tailscale.exe", "C:\\Program Files\\Tailscale\\tailscale.exe"];
}

function isMissingExecutableError(error: unknown): boolean {
  return error instanceof Error && /ENOENT|not recognized|cannot find/i.test(error.message);
}

function extractTailscaleFunnelUrl(text: string): string | null {
  const status = JSON.parse(text) as {
    Foreground?: Record<string, TailscaleServeConfig>;
    Background?: Record<string, TailscaleServeConfig>;
  };

  for (const config of [...Object.values(status.Background ?? {}), ...Object.values(status.Foreground ?? {})]) {
    for (const [hostPort] of Object.entries(config.AllowFunnel ?? {})) {
      const host = hostPort.replace(/:443$/, "");
      return `https://${host}`;
    }
    const webHost = Object.keys(config.Web ?? {})[0];
    if (webHost) return `https://${webHost.replace(/:443$/, "")}`;
  }

  return null;
}

interface TailscaleServeConfig {
  Web?: Record<string, unknown>;
  AllowFunnel?: Record<string, boolean>;
}
