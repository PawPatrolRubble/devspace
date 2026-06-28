import { spawn } from "node:child_process";
import { readdirSync, statSync, watch } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const srcRoot = join(repoRoot, "src");
const uiRoot = join(srcRoot, "ui");
const watchRoots = [srcRoot];
const restartDelayMs = 750;
const crashDelayMs = 1500;
const extraArgs = process.argv.slice(2);

let child;
let uiBuildWatcher;
let restartTimer;
let stoppingForRestart = false;
let shuttingDown = false;

function log(message) {
  console.error(`[devspace:dev] ${message}`);
}

function isWithin(root, path) {
  const relativePath = relative(root, path);
  return relativePath === "" || (!relativePath.startsWith("..") && relativePath !== "");
}

function spawnNpm(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return spawn(process.execPath, [npmExecPath, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
  }

  return spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
}

function runUiBuildOnce() {
  log("building dashboard UI");

  return new Promise((resolveBuild, rejectBuild) => {
    const build = spawnNpm(["run", "build:app"]);

    build.on("error", rejectBuild);
    build.on("exit", (code, signal) => {
      if (code === 0) {
        resolveBuild();
        return;
      }

      rejectBuild(new Error(`dashboard build exited (${signal ?? code ?? "unknown"})`));
    });
  });
}

function startUiBuildWatcher() {
  if (uiBuildWatcher || shuttingDown) return;

  log("watching src/ui; dashboard rebuilds on changes");
  uiBuildWatcher = spawnNpm(["run", "build:app", "--", "--watch"]);

  uiBuildWatcher.on("error", (error) => {
    log(`dashboard build watcher failed: ${error.message}`);
  });

  uiBuildWatcher.on("exit", (code, signal) => {
    uiBuildWatcher = undefined;
    if (shuttingDown) return;

    log(`dashboard build watcher exited (${signal ?? code ?? "unknown"}); restarting in ${crashDelayMs}ms`);
    setTimeout(() => startUiBuildWatcher(), crashDelayMs).unref();
  });
}

function start() {
  stoppingForRestart = false;
  child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", ...extraArgs], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });

  child.on("exit", (code, signal) => {
    child = undefined;
    if (shuttingDown) return;
    if (stoppingForRestart) return;

    log(`server exited (${signal ?? code ?? "unknown"}); restarting in ${crashDelayMs}ms`);
    scheduleRestart(crashDelayMs);
  });
}

function scheduleRestart(delayMs = restartDelayMs) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(restart, delayMs);
}

function killProcess(proc, force = false) {
  if (!proc) return;
  if (process.platform === "win32") {
    // Windows: SIGTERM/SIGKILL not supported; use taskkill for force
    if (force) {
      spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { windowsHide: true });
    } else {
      proc.kill();
    }
  } else {
    proc.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

function killChild(force = false) {
  killProcess(child, force);
}

function restart() {
  if (shuttingDown) return;
  clearTimeout(restartTimer);

  if (!child) {
    start();
    return;
  }

  stoppingForRestart = true;
  child.once("exit", () => {
    if (!shuttingDown) start();
  });
  killChild(false);

  setTimeout(() => {
    if (child && stoppingForRestart) killChild(true);
  }, 3000).unref();
}

function watchDirectory(root) {
  const watchers = [];
  const seen = new Set();

  function addDirectory(dir) {
    if (seen.has(dir)) return;
    seen.add(dir);

    const watcher = watch(dir, (event, filename) => {
      if (!filename) {
        scheduleRestart();
        return;
      }

      const path = join(dir, filename.toString());
      if (event === "rename") maybeAddDirectory(path);
      if (isWithin(uiRoot, path)) return;
      scheduleRestart();
    });
    watchers.push(watcher);

    for (const entry of readdirSync(dir)) {
      maybeAddDirectory(join(dir, entry));
    }
  }

  function maybeAddDirectory(path) {
    try {
      const stats = statSync(path);
      if (stats.isDirectory()) addDirectory(path);
    } catch {
      // The file may have been deleted between the watch event and stat call.
    }
  }

  addDirectory(root);
  return watchers;
}

function shutdown() {
  shuttingDown = true;
  clearTimeout(restartTimer);
  killProcess(uiBuildWatcher, false);

  if (!child) return process.exit(0);

  child.once("exit", () => process.exit(0));
  killChild(false);
  setTimeout(() => process.exit(1), 3000).unref();
}

async function main() {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, shutdown);
  }

  for (const root of watchRoots) {
    watchDirectory(root);
  }

  await runUiBuildOnce();
  startUiBuildWatcher();
  log("watching src (excluding src/ui); server restarts on changes and after crashes");
  start();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
