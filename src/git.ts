import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export interface GitEligibility {
  ok: boolean;
  gitRoot?: string;
  reason?: "not_git" | "no_head";
  message?: string;
}

type GitToolContent = { type: "text"; text: string };

export interface GitToolResponse extends Record<string, unknown> {
  content: GitToolContent[];
  isError?: boolean;
}

export interface GitDiffToolInput {
  path?: string;
  staged?: boolean;
  context?: number;
}

export interface GitLogToolInput {
  path?: string;
  limit?: number;
}

export async function git(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {},
): Promise<GitCommandResult> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });

  return { stdout, stderr };
}

export async function getGitEligibility(cwd: string): Promise<GitEligibility> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return {
      ok: false,
      reason: "not_git",
      message: "workspace is not inside a git repository",
    };
  }

  const gitRoot = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  try {
    await git(gitRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    return {
      ok: false,
      gitRoot,
      reason: "no_head",
      message: "repository has no HEAD commit",
    };
  }

  return { ok: true, gitRoot };
}

function gitToolResponse(text: string): GitToolResponse {
  return { content: [{ type: "text", text }] };
}

function gitToolError(error: unknown): GitToolResponse {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function gitStatusTool(cwd: string): Promise<GitToolResponse> {
  try {
    const result = await git(cwd, ["status", "--short", "--branch"]);
    return gitToolResponse(result.stdout.trimEnd() || "No changes.");
  } catch (error) {
    return gitToolError(error);
  }
}

export async function gitDiffTool(cwd: string, input: GitDiffToolInput = {}): Promise<GitToolResponse> {
  try {
    const args = ["diff"];
    if (input.staged) args.push("--cached");
    if (input.context !== undefined) args.push(`--unified=${input.context}`);
    if (input.path) args.push("--", input.path);

    const result = await git(cwd, args);
    return gitToolResponse(result.stdout.trimEnd() || "No diff.");
  } catch (error) {
    return gitToolError(error);
  }
}

export async function gitLogTool(cwd: string, input: GitLogToolInput = {}): Promise<GitToolResponse> {
  try {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
    const args = [
      "log",
      `-${limit}`,
      "--date=short",
      "--pretty=format:%h %ad %an %s",
    ];
    if (input.path) args.push("--", input.path);

    const result = await git(cwd, args);
    return gitToolResponse(result.stdout.trimEnd() || "No commits.");
  } catch (error) {
    return gitToolError(error);
  }
}

export function safeWorkspaceRefSegment(workspaceId: string): string {
  const safe = workspaceId.replace(/[^A-Za-z0-9._-]/g, "-");
  return safe.length > 0 ? safe : createHash("sha256").update(workspaceId).digest("hex").slice(0, 16);
}
