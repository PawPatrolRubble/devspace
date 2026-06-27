import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

export interface TunnelResult {
  /** The captured public tunnel URL (e.g. https://something.trycloudflare.com) */
  url: string;
  /** The cloudflared child process, for lifecycle management */
  process: ChildProcess;
}

/**
 * Starts a cloudflared quick tunnel and resolves when the public URL is captured.
 *
 * Equivalent to running: cloudflared tunnel --url http://127.0.0.1:{port}
 */
export async function startCloudflareTunnel(port: number, timeoutMs = 30_000): Promise<TunnelResult> {
  const bin = platform() === "win32" ? "cloudflared.exe" : "cloudflared";
  const args = ["tunnel", "--url", `http://127.0.0.1:${port}`];

  const proc = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return new Promise<TunnelResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `cloudflared did not produce a tunnel URL within ${timeoutMs / 1000}s. ` +
            "Check that cloudflared is installed and working.",
        ),
      );
    }, timeoutMs);

    let stderr = "";

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      const url = extractTunnelUrl(text);

      if (url) {
        clearTimeout(timeout);
        resolve({ url, process: proc });
      }
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "cloudflared is not installed or not on PATH.\n" +
              "Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
          ),
        );
      } else {
        reject(new Error(`Failed to start cloudflared: ${err.message}`));
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(
          new Error(
            `cloudflared exited with code ${code}.\n${stderr.trim()}`,
          ),
        );
      }
    });
  });
}

/** Try to extract a trycloudflare.com URL from a line of cloudflared output. */
function extractTunnelUrl(text: string): string | null {
  // cloudflared outputs the URL inside a banner like:
  // |  https://something.trycloudflare.com  |
  // Also handles newer log formats and bare lines.
  const match = text.match(/(https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)/);
  return match ? match[1] : null;
}
