import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { readUrl, requestJson, search } from "../src/core.js";
import { assertSafeReadUrl } from "../src/policy.js";
import { manageSkills } from "../src/skills.js";

let server;
let baseUrl;
let requestedSearches;
let authorizationHeader;

before(async () => {
  requestedSearches = [];
  server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    authorizationHeader = request.headers.authorization;
    if (url.pathname === "/config" || url.pathname === "/prefix/config") {
      return json(response, {
        instance_name: "test",
        version: "test",
        safe_search: 1,
        default_locale: "",
        categories: ["general", "it"],
        engines: [
          { name: "brave", enabled: true, categories: ["general"] },
          { name: "google", enabled: true, categories: ["general"] },
          { name: "wikipedia", enabled: true, categories: ["general"] },
          { name: "mdn", enabled: true, categories: ["it"] },
        ],
      });
    }
    if (url.pathname === "/search") {
      requestedSearches.push(url);
      if (url.searchParams.get("q") === "fail") return json(response, { error: "nope" }, 503);
      const page = Number(url.searchParams.get("pageno") || 1);
      return json(response, {
        results: page === 1
          ? [{ title: "One", url: "https://example.test/one?utm_source=test", content: "first", engine: "brave" }, { title: "Two", url: "https://example.test/two", content: "second", engine: "google" }]
          : [{ title: "One duplicate", url: "https://example.test/one", content: "duplicate", engine: "wikipedia" }, { title: "Three", url: "https://example.test/three", content: "third", engine: "brave" }],
        unresponsive_engines: [],
        suggestions: [],
      });
    }
    if (url.pathname === "/page") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end("<title>Local Test</title><main>Hello <strong>agent</strong><script>drop()</script\t\n bar><style>hide()</style ><noscript>ignore()</noscript >&amp;lt;literal</main>");
    }
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/page" });
      return response.end();
    }
    if (url.pathname === "/binary") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      return response.end("not text");
    }
    response.writeHead(404).end();
  }).listen(0, "127.0.0.1", () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  await new Promise((resolve) => server.once("listening", resolve));
});

after(() => server.close());

test("search uses explicit engine routing without category widening and deduplicates across pages", async () => {
  const result = await search(baseUrl, { query: "test", mode: "general", limit: 3, pages: 2, timeout: 1000 });
  assert.deepEqual(result.requested_engines, ["brave", "google", "wikipedia"]);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0].url, "https://example.test/one?utm_source=test");
  assert.equal(result.results[0].source_count, 2);
  assert.equal(requestedSearches.length, 2);
  assert.equal(requestedSearches[0].searchParams.get("engines"), "brave,google,wikipedia");
  assert.equal(requestedSearches[0].searchParams.get("categories"), null);
});

test("explicit engine names are validated against the discovered configuration", async () => {
  const result = await search(baseUrl, { query: "test", mode: "general", engines: "mdn,missing", limit: 2, pages: 1, timeout: 1000 });
  assert.deepEqual(result.requested_engines, ["mdn"]);
  assert.deepEqual(result.unavailable_engines, ["missing"]);
});

test("explicit categories replace profile engines", async () => {
  const result = await search(baseUrl, { query: "category", category: "it", limit: 2, pages: 1, timeout: 1000 });
  const request = requestedSearches.at(-1);
  assert.deepEqual(result.requested_engines, []);
  assert.deepEqual(result.requested_categories, ["it"]);
  assert.equal(request.searchParams.get("categories"), "it");
  assert.equal(request.searchParams.get("engines"), null);
});

test("invalid numeric search options fail closed", async () => {
  await assert.rejects(
    () => search(baseUrl, { query: "test", limit: "not-a-number" }),
    (error) => error.type === "usage" && error.exitCode === 2,
  );
});

test("search fails when every requested page fails", async () => {
  await assert.rejects(
    () => search(baseUrl, { query: "fail", mode: "general", pages: 2, timeout: 1000 }),
    (error) => error.type === "network" && error.exitCode === 3,
  );
});

test("raw API resolution cannot escape the configured origin", async () => {
  await assert.rejects(
    () => requestJson(baseUrl, "//example.com/config", {}, 1000),
    (error) => error.type === "usage" && error.exitCode === 2,
  );
});

test("SearXNG API paths remain relative to a configured base path", async () => {
  const response = await requestJson(`${baseUrl}/prefix`, "/config", {}, 1000);
  assert.equal(new URL(response.url).pathname, "/prefix/config");
});

test("SearXNG endpoint credentials become an Authorization header and are removed from request metadata", async () => {
  const authenticated = new URL(baseUrl);
  authenticated.username = "agent";
  authenticated.password = "test-value";
  const response = await requestJson(authenticated.toString(), "/config", {}, 1000);
  assert.equal(authorizationHeader, `Basic ${Buffer.from("agent:test-value").toString("base64")}`);
  assert.equal(new URL(response.url).username, "");
  assert.equal(new URL(response.url).password, "");
});

test("private URL reads require explicit opt-in", async () => {
  await assert.rejects(() => assertSafeReadUrl(baseUrl), (error) => error.type === "security" && error.exitCode === 4);
  await assert.rejects(() => assertSafeReadUrl("http://[::1]/"), (error) => error.type === "security" && error.exitCode === 4);
  await assert.rejects(() => assertSafeReadUrl("http://[::ffff:127.0.0.1]/"), (error) => error.type === "security" && error.exitCode === 4);
  await assert.rejects(() => assertSafeReadUrl("http://[2001:db8::1]/"), (error) => error.type === "security" && error.exitCode === 4);
});

test("private URL opt-in pins the validated target across redirects", async () => {
  const result = await readUrl(`${baseUrl}/redirect`, {
    timeout: 1000,
    maxChars: 1000,
    allowPrivate: true,
    validateUrl: assertSafeReadUrl,
  });
  assert.equal(result.title, "Local Test");
  assert.match(result.text, /Hello agent/);
  assert.doesNotMatch(result.text, /drop|hide|ignore/);
  assert.match(result.text, /&lt;literal/);
  assert.equal(result.url, `${baseUrl}/page`);
});

test("URL reads reject binary content", async () => {
  await assert.rejects(
    () => readUrl(`${baseUrl}/binary`, { timeout: 1000, maxChars: 1000, allowPrivate: true, validateUrl: assertSafeReadUrl }),
    (error) => error.type === "security" && error.exitCode === 4,
  );
});

test("Skill lifecycle installs, reports, updates, and uninstalls owned directories", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-cli-skills-"));
  try {
    const installed = await manageSkills("install", { dir: target });
    assert.equal(installed.targets[0].skills.length, 4);
    assert.ok(installed.targets[0].skills.every((skill) => skill.status === "current"));
    const status = await manageSkills("status", { dir: target });
    assert.ok(status.targets[0].skills.every((skill) => skill.status === "current"));
    const updated = await manageSkills("update", { dir: target });
    assert.ok(updated.targets[0].skills.every((skill) => skill.status === "current"));
    const removed = await manageSkills("uninstall", { dir: target });
    assert.ok(removed.targets[0].skills.every((skill) => skill.status === "missing"));
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("Skill installation refuses unmanaged name collisions", async () => {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-cli-skills-"));
  try {
    const conflict = path.join(target, "searxng-web-search");
    await fs.mkdir(conflict);
    await fs.writeFile(path.join(conflict, "SKILL.md"), "user-owned\n");
    await assert.rejects(
      () => manageSkills("install", { dir: target }),
      (error) => error.type === "security" && error.exitCode === 4,
    );
    assert.equal(await fs.readFile(path.join(conflict, "SKILL.md"), "utf8"), "user-owned\n");
  } finally {
    await fs.rm(target, { recursive: true, force: true });
  }
});

test("Skill status does not create a missing target directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "searxng-cli-status-"));
  const target = path.join(root, "missing");
  try {
    const status = await manageSkills("status", { dir: target });
    assert.ok(status.targets[0].skills.every((skill) => skill.status === "missing"));
    await assert.rejects(() => fs.access(target), (error) => error.code === "ENOENT");
    await assert.rejects(
      () => manageSkills("status", { dir: target, target: "codex" }),
      (error) => error.type === "usage" && error.exitCode === 2,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
