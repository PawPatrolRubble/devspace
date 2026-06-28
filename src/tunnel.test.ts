import assert from "node:assert/strict";
import { startTailscaleFunnel } from "./tunnel.js";

type ExecCall = { command: string; args: string[] };

{
  const calls: ExecCall[] = [];
  const result = await startTailscaleFunnel(7676, 1000, (command, args, _options, callback) => {
    calls.push({ command, args });
    if (args[0] === "funnel" && args[1] === "--bg") {
      callback(null, "", "");
      return;
    }
    callback(null, JSON.stringify({
      Background: {
        abc123: {
          Web: {
            "ginchou.taildea223.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7676" } } },
          },
          AllowFunnel: {
            "ginchou.taildea223.ts.net:443": true,
          },
        },
      },
    }), "");
  });

  assert.equal(result.url, "https://ginchou.taildea223.ts.net");
  assert.deepEqual(calls.map((call) => call.args), [
    ["funnel", "--bg", "--yes", "7676"],
    ["funnel", "status", "--json"],
  ]);
}

{
  const result = await startTailscaleFunnel(7676, 1000, (_command, args, _options, callback) => {
    if (args[0] === "funnel" && args[1] === "--bg") {
      callback(null, "", "");
      return;
    }
    callback(null, JSON.stringify({
      Foreground: {
        abc123: {
          Web: {
            "ginchou.taildea223.ts.net:443": { Handlers: { "/": { Text: "hello" } } },
          },
        },
      },
    }), "");
  });

  assert.equal(result.url, "https://ginchou.taildea223.ts.net");
}

{
  await assert.rejects(
    startTailscaleFunnel(7676, 1000, (_command, args, _options, callback) => {
      if (args[0] === "funnel" && args[1] === "--bg") {
        callback(null, "", "");
        return;
      }
      callback(null, JSON.stringify({ Background: {} }), "");
    }),
    /Tailscale Funnel did not report a public URL/,
  );
}
