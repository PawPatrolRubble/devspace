import assert from "node:assert/strict";
import { InteractionLog } from "./interaction-log.js";

const log = new InteractionLog(2);
const notifications: string[] = [];
const unsubscribe = log.subscribe((event) => notifications.push(event.id));

const first = log.recordToolCall({
  tool: "read",
  workspaceId: "ws_test",
  path: "README.md",
  success: true,
  durationMs: 12,
});
log.recordToolCall({
  tool: "edit",
  workspaceId: "ws_test",
  path: "src/server.ts",
  success: true,
  durationMs: 23,
});
const third = log.recordToolCall({
  tool: "bash",
  workspaceId: "ws_test",
  workingDirectory: ".",
  commandPreview: "npm test",
  commandLength: 8,
  success: false,
  durationMs: 34,
  error: "Test failed",
});

assert.equal(first.id, "interaction_1");
assert.equal(third.target, ".");
assert.deepEqual(notifications, ["interaction_1", "interaction_2", "interaction_3"]);

const snapshot = log.snapshot();
assert.equal(snapshot.summary.total, 3);
assert.equal(snapshot.summary.succeeded, 2);
assert.equal(snapshot.summary.failed, 1);
assert.deepEqual(snapshot.summary.byTool, { bash: 1, edit: 1, read: 1 });
assert.equal(snapshot.summary.lastEventId, "interaction_3");
assert.deepEqual(snapshot.events.map((event) => event.id), ["interaction_3", "interaction_2"]);

unsubscribe();
log.recordToolCall({
  tool: "read",
  success: true,
  durationMs: 1,
});
assert.deepEqual(notifications, ["interaction_1", "interaction_2", "interaction_3"]);