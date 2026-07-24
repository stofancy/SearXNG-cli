import { spawnSync } from "node:child_process";

export function emitSuccess(data, format = "json", jq) {
  const envelope = { ok: true, data };
  if (jq) return emitJq(envelope, jq);
  if (format === "pretty") return process.stdout.write(`${pretty(data)}\n`);
  if (format === "ndjson" && Array.isArray(data.results)) {
    for (const result of data.results) process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (format === "csv" && Array.isArray(data.results)) {
    process.stdout.write("rank,title,url,engine,snippet\n");
    for (const result of data.results) process.stdout.write(`${[result.rank, result.title, result.url, result.engine, result.snippet].map(csv).join(",")}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

export function emitFailure(error) {
  const envelope = { ok: false, error: { type: error.type || "internal", message: error.message || String(error), retryable: Boolean(error.retryable) } };
  process.stderr.write(`${JSON.stringify(envelope)}\n`);
}

function pretty(data) {
  if (data.results) return [`Query: ${data.query}`, `Mode: ${data.mode}`, `Engines: ${data.requested_engines?.join(", ") || "server default"}`, `Results: ${data.results.length}`, ...data.results.map((item) => `${item.rank}. ${item.title}\n   ${item.url}\n   ${item.snippet}`), data.failed_engines?.length ? `Failed: ${data.failed_engines.map((item) => `${item.name} (${item.reason})`).join(", ")}` : ""].filter(Boolean).join("\n");
  return JSON.stringify(data, null, 2);
}

function csv(value) { return `"${String(value ?? "").replaceAll('"', '""').replaceAll("\n", " ")}"`; }

function emitJq(value, expression) {
  const result = spawnSync("jq", [expression], { input: JSON.stringify(value), encoding: "utf8" });
  if (result.error) throw new Error("--jq requires jq to be installed");
  if (result.status !== 0) throw new Error(result.stderr.trim() || "jq expression failed");
  process.stdout.write(result.stdout);
}
