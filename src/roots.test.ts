import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedPath, expandHomePath, resolveAllowedPath, resolveCanonicalAllowedPath } from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/devspace"), resolve(home, "personal", "devspace"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/devspace", [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  assertAllowedPath("~/personal/devspace", ["~/personal"]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

const fixture = mkdtempSync(join(tmpdir(), "devspace-canonical-test-"));
try {
  const root = join(fixture, "root");
  const outside = join(fixture, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolveCanonicalAllowedPath("escape/secret.txt", root, [root]), /outside allowed roots/);
  assert.throws(() => resolveCanonicalAllowedPath("escape/new.txt", root, [root]), /outside allowed roots/);
  const inner = join(root, "new-dir", "file.txt");
  assert.equal(resolveCanonicalAllowedPath(inner, root, [root]), inner);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
