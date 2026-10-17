import { homedir } from "node:os";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  const relationship = relative(resolvedRoot, resolvedPath);

  return (
    relationship === "" ||
    (!isAbsolute(relationship) && !relationship.startsWith("..") && relationship !== ".." && !relationship.includes(`..${sep}`))
  );
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  const absolutePath = resolve(cwd, inputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}

/**
 * Check lexical and canonical containment without rewriting a configured symlink root.
 * This is a preflight check, not a race-free operating-system sandbox.
 */
export function resolveCanonicalAllowedPath(
  inputPath: string,
  cwd: string,
  allowedRoots: string[],
): string {
  const logicalPath = resolveAllowedPath(inputPath, cwd, allowedRoots);
  canonicalAllowedPath(logicalPath, allowedRoots);
  return logicalPath;
}

export function canonicalAllowedPath(inputPath: string, allowedRoots: string[]): string {
  const logicalPath = assertAllowedPath(inputPath, allowedRoots);
  const canonicalPath = canonicalizePath(logicalPath);
  if (allowedRoots.some((root) => isPathInsideRoot(canonicalPath, canonicalizePath(root)))) {
    return canonicalPath;
  }
  throw new AccessDeniedError(`Path is outside allowed roots: ${inputPath}`);
}

function canonicalizePath(inputPath: string): string {
  const absolutePath = resolve(expandHomePath(inputPath));
  let candidate = absolutePath;
  for (;;) {
    try {
      const real = realpathSync(candidate);
      const suffix = relative(candidate, absolutePath);
      return suffix ? resolve(real, suffix) : real;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      try {
        if (lstatSync(candidate).isSymbolicLink()) {
          throw new AccessDeniedError(`Cannot resolve symbolic link: ${inputPath}`);
        }
      } catch (lstatError) {
        if (!isMissingPathError(lstatError)) throw lstatError;
      }
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    typeof error === "object" && error !== null && "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR"),
  );
}
