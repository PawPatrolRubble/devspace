import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistPublicBaseUrlSetting } from "./cli.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

for (const flag of ["-v", "--version"]) {
  const output = execFileSync("node", ["--import", "tsx", "src/cli.ts", flag], {
    encoding: "utf8",
    env: { ...process.env, DEVSPACE_CONFIG_DIR: "/tmp/devspace-cli-version-test" },
  }).trim();

  assert.equal(output, packageJson.version);
}

const configDir = mkdtempSync(join(tmpdir(), "devspace-cli-config-test-"));
const configPath = join(configDir, "config.json");

writeFileSync(
  configPath,
  JSON.stringify({
    host: "127.0.0.1",
    port: 7676,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://old.taildea223.ts.net",
  }),
);

assert.equal(
  persistPublicBaseUrlSetting("https://new.taildea223.ts.net", { DEVSPACE_CONFIG_DIR: configDir }),
  configPath,
);
assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
  host: "127.0.0.1",
  port: 7676,
  allowedRoots: [process.cwd()],
  publicBaseUrl: "https://new.taildea223.ts.net",
});
