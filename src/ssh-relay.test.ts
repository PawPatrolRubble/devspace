import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { resolveSshRelayOptions, sshRelayArguments, startSshRelay } from "./ssh-relay.js";

const settings = resolveSshRelayOptions({
  host: "relay.example.com", user: "devspace", sshPort: 2222, remotePort: 17676,
}, 7676);
const args = sshRelayArguments(settings);
assert.deepEqual(args.slice(args.indexOf("-R") + 1), [
  "127.0.0.1:17676:127.0.0.1:7676", "devspace@relay.example.com",
]);
for (const required of [
  "StrictHostKeyChecking=yes", "ExitOnForwardFailure=yes", "BatchMode=yes",
]) assert.equal(args.includes(required), true);
assert.equal(args.some((x) => x.startsWith("0.0.0.0:")), false);

assert.throws(() => resolveSshRelayOptions(undefined, 7676), /not configured/);
assert.throws(() => resolveSshRelayOptions({ host: "-invalid", user: "devspace" }, 7676));
assert.throws(() => resolveSshRelayOptions({ host: "relay.example.com", user: "-invalid" }, 7676));
assert.throws(() => resolveSshRelayOptions({ host: "relay.example.com", user: "devspace", remotePort: 22 }, 7676));
assert.throws(() => resolveSshRelayOptions({ host: "relay.example.com", user: "devspace", sshPort: 65536 }, 7676));

const spawned: Array<EventEmitter & { stderr: EventEmitter; kill(): boolean }> = [];
const messages: string[] = [];
const relay = startSshRelay(settings, {
  spawnProcess: ((_name: string, _args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      kill(): boolean { return true; },
    });
    spawned.push(child);
    return child as unknown as ChildProcess;
  }) as typeof import("node:child_process").spawn,
  retryBaseMs: 5,
  retryMaxMs: 5,
  onEvent: (message) => messages.push(message),
});
assert.equal(spawned.length, 1);
spawned[0].emit("close", 255, null);
await new Promise<void>((resolve) => setTimeout(resolve, 30));
assert.equal(spawned.length, 2, "unexpected exit should cause a reconnect");
relay.stop();
spawned[1].emit("close", 0, null);
await new Promise<void>((resolve) => setTimeout(resolve, 30));
assert.equal(spawned.length, 2, "stop should prevent further reconnects");
assert.equal(messages.some((message) => message.includes("retrying")), true);
