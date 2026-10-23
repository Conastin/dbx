// CDP helper: evaluate an expression in the dbx app page and print JSON result.
// Usage: node upstream-drafts/cdp-12878-eval.mjs "<expression>" [--screenshot out.png]
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const expression = args[0];
const shotIdx = args.indexOf("--screenshot");
const shotPath = shotIdx >= 0 ? args[shotIdx + 1] : undefined;

const list = await fetch("http://127.0.0.1:9223/json/list").then((r) => r.json());
const page = list.find((t) => t.type === "page" && t.url.startsWith("http"));
if (!page) {
  console.error(JSON.stringify({ error: "no page target", targets: list.map((t) => t.type) }));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
}
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
await send("Runtime.enable");
const result = { evaluated: null, screenshot: null };
if (expression) {
  const evaluation = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  result.evaluated = evaluation.exceptionDetails
    ? { exception: evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text }
    : evaluation.result.value;
}
if (shotPath) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  result.screenshot = shotPath;
}
console.log(JSON.stringify(result, null, 2));
ws.close();
process.exit(0);
