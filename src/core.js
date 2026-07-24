import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliError, fetchPublic, PROFILES, selectProfile } from "./policy.js";

const DEFAULT_URL = "http://127.0.0.1:8080";
const DEFAULT_TIMEOUT = 12000;

export function resolveSearxngUrl(explicit) {
  if (explicit) return explicit.replace(/\/$/, "");
  if (process.env.SEARXNG_CLI_URL) return process.env.SEARXNG_CLI_URL.replace(/\/$/, "");
  if (process.env.SEARXNG_URL) return process.env.SEARXNG_URL.replace(/\/$/, "");
  return readCliConfig()?.searxng_url?.replace(/\/$/, "") || DEFAULT_URL;
}

export function cliConfigPath() {
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return process.env.SEARXNG_CLI_CONFIG || path.join(configRoot, "searxng-cli", "config.json");
}

function readCliConfig() {
  try {
    return JSON.parse(fsSync.readFileSync(cliConfigPath(), "utf8"));
  } catch {
    return undefined;
  }
}

export async function writeCliConfig(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw cliError(`Invalid SearXNG URL: ${rawUrl}`, "usage", 2); }
  if (!['http:', 'https:'].includes(url.protocol)) throw cliError("SearXNG URL must use http or https", "usage", 2);
  if (url.search || url.hash) throw cliError("SearXNG URL cannot include a query or fragment", "usage", 2);
  const configPath = cliConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath, `${JSON.stringify({ searxng_url: rawUrl.replace(/\/$/, "") }, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
  return configPath;
}

export function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString().replace(/\/$/, "");
  } catch { return "<invalid-url>"; }
}

export async function requestJson(baseUrl, pathname, params = {}, timeoutMs = DEFAULT_TIMEOUT, options = {}) {
  const url = endpointUrl(baseUrl, pathname);
  const authorization = url.username || url.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`
    : undefined;
  url.username = "";
  url.password = "";
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json", ...(authorization ? { authorization } : {}), ...(options.headers || {}) } });
    const body = await response.text();
    let data;
    try { data = JSON.parse(body); } catch { data = undefined; }
    if (!response.ok) {
      throw cliError(`SearXNG returned HTTP ${response.status}`, "network", 3, response.status >= 500);
    }
    if (data === undefined) throw cliError("SearXNG returned invalid JSON", "protocol", 3, true);
    return { data, url: url.toString(), status: response.status };
  } catch (error) {
    if (error.name === "AbortError") throw cliError(`Request timed out after ${timeoutMs}ms`, "timeout", 5, true);
    if (error.type) throw error;
    throw cliError(`SearXNG request failed: ${error.message}`, "network", 3, true);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchConfig(baseUrl, timeoutMs) {
  return (await requestJson(baseUrl, "/config", {}, timeoutMs)).data;
}

export function enabledEngines(config, category, onlyEnabled = true) {
  let engines = (config.engines || []).filter((engine) => !onlyEnabled || engine.enabled !== false);
  if (category) {
    const requested = new Set(category.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
    engines = engines.filter((engine) => (engine.categories || []).some((item) => requested.has(item.toLowerCase())));
  }
  return engines;
}

export function engineNames(config, requested) {
  const available = new Map(enabledEngines(config).map((engine) => [engine.name.toLowerCase(), engine.name]));
  const valid = [];
  const unavailable = [];
  for (const name of requested) {
    const canonical = available.get(name.toLowerCase());
    (canonical ? valid : unavailable).push(canonical || name);
  }
  return { valid: [...new Set(valid)], unavailable: [...new Set(unavailable)] };
}

export async function search(baseUrl, options) {
  const query = options.query?.trim();
  if (!query) throw cliError("--query is required", "usage", 2);
  if (options.engines && options.category) throw cliError("--engines and --category cannot be used together", "usage", 2);
  const limit = integerOption(options.limit, "limit", 30, 1, 100);
  const pages = integerOption(options.pages, "pages", Math.ceil(limit / 15), 1, 10);
  const firstPage = integerOption(options.page, "page", 1, 1);
  const timeout = integerOption(options.timeout, "timeout", DEFAULT_TIMEOUT, 1);
  if (options.safesearch !== undefined && !["0", "1", "2", 0, 1, 2].includes(options.safesearch)) {
    throw cliError("--safesearch must be 0, 1, or 2", "usage", 2);
  }
  if (options.timeRange && !["day", "month", "year"].includes(options.timeRange)) {
    throw cliError("--time-range must be day, month, or year", "usage", 2);
  }
  const { mode, profile } = selectProfile(options.mode || "auto", query);
  const requestedCategories = options.category
    ? options.category.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
  let requested = requestedCategories.length
    ? []
    : options.engines?.split(",").map((item) => item.trim()).filter(Boolean) || profile.engines;
  let unavailable = [];
  try {
    const config = await fetchConfig(baseUrl, timeout);
    if (requestedCategories.length) validateCategories(config, requestedCategories);
    else {
      const resolved = engineNames(config, requested);
      requested = resolved.valid;
      unavailable = resolved.unavailable;
    }
  } catch (error) {
    if (options.engines || options.category || options.mode !== "auto") throw error;
    requested = [];
  }
  const results = [];
  const seen = new Map();
  const failed = [...unavailable.map((name) => ({ name, reason: "not_enabled" }))];
  const metadata = { answers: [], corrections: [], suggestions: [], infoboxes: [] };
  let pagesAttempted = 0;
  let pagesFetched = 0;
  let lastPageError;
  for (let page = firstPage; page < firstPage + pages && results.length < limit; page += 1) {
    pagesAttempted += 1;
    const params = {
      q: query,
      format: "json",
      pageno: page,
      language: options.language,
      time_range: options.timeRange,
      safesearch: options.safesearch,
      // SearXNG treats categories as an additional selection. When the CLI
      // has an explicit profile/engine set, omitting categories is necessary
      // to prevent unrelated engines from being added back into the query.
      categories: requested.length ? undefined : requestedCategories.join(",") || profile.category,
      engines: requested.length ? requested.join(",") : undefined,
    };
    try {
      const response = await requestJson(baseUrl, "/search", params, timeout);
      pagesFetched += 1;
      const data = response.data;
      for (const key of Object.keys(metadata)) if (Array.isArray(data[key])) metadata[key].push(...data[key]);
      for (const item of data.results || []) {
        if (!item.url) continue;
        const key = normalizeUrl(item.url);
        const current = seen.get(key);
        if (current) {
          current.engines = [...new Set([...current.engines, item.engine, ...(item.engines || [])].filter(Boolean))];
          current.source_count = current.engines.length;
          continue;
        }
        const normalized = normalizeResult(item, results.length + 1);
        seen.set(key, normalized);
        results.push(normalized);
      }
      for (const entry of data.unresponsive_engines || []) {
        const [name, reason] = Array.isArray(entry) ? entry : [String(entry), "unresponsive"];
        if (!failed.some((item) => item.name === name)) failed.push({ name, reason });
      }
    } catch (error) {
      lastPageError = error;
      failed.push({ name: `page:${page}`, reason: error.message });
    }
  }
  if (pagesFetched === 0) throw lastPageError || cliError("Every search page failed", "network", 3, true);
  const sliced = results.slice(0, limit).map((item, index) => ({ ...item, rank: index + 1 }));
  return {
    query,
    mode,
    requested_engines: requested,
    requested_categories: requestedCategories,
    unavailable_engines: unavailable,
    failed_engines: failed,
    results: sliced,
    metadata: dedupeMetadata(metadata),
    page: firstPage,
    pages_attempted: pagesAttempted,
    pages_fetched: pagesFetched,
    next_page: results.length >= limit ? firstPage + pagesAttempted : null,
    partial: failed.length > 0,
  };
}

function normalizeResult(item, rank) {
  const engines = [...new Set([item.engine, ...(item.engines || [])].filter(Boolean))];
  return {
    rank,
    title: item.title || "",
    url: item.url,
    snippet: item.content || item.snippet || "",
    engine: item.engine || null,
    engines,
    source_count: engines.length,
    published_at: item.publishedDate || item.published_at || null,
    category: item.category || null,
    score: item.score ?? null,
  };
}

function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$)/i.test(key)) url.searchParams.delete(key);
    return url.toString().replace(/\/$/, "");
  } catch { return raw; }
}

function dedupeMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata).map(([key, values]) => [key, [...new Set(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)))].slice(0, 20)]));
}

export async function readUrl(rawUrl, options) {
  const url = await options.validateUrl(rawUrl, options.allowPrivate);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout);
  try {
    const response = await fetchPublic(url, { signal: controller.signal, headers: { accept: "text/html,text/plain,application/xhtml+xml" }, allowPrivate: options.allowPrivate });
    if (!response.ok) throw cliError(`URL returned HTTP ${response.status}`, "network", 3, response.status >= 500);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (contentType && !["text/html", "text/plain", "application/xhtml+xml", "application/json"].includes(contentType)) {
      throw cliError(`Unsupported content type: ${contentType}`, "security", 4);
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (length > options.maxChars * 4) throw cliError("Response exceeds configured size limit", "security", 4);
    const body = await readLimitedBody(response, Math.max(options.maxChars * 4, 1024 * 1024));
    const extracted = htmlToText(body);
    const text = extracted.slice(0, options.maxChars);
    return { url: response.url, title: extractTitle(body), text, truncated: text.length < extracted.length };
  } catch (error) {
    if (error.name === "AbortError") throw cliError(`Read timed out after ${options.timeout}ms`, "timeout", 5, true);
    if (error.type) throw error;
    throw cliError(`URL read failed: ${error.message}`, "network", 3, true);
  } finally { clearTimeout(timeout); }
}

function extractTitle(html) {
  return (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function htmlToText(html) {
  const withoutBlockedElements = ["script", "style", "noscript"]
    .reduce((text, tagName) => stripElementBlocks(text, tagName), html);
  const withoutTags = withoutBlockedElements
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|article|section|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags)
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

function stripElementBlocks(html, tagName) {
  const lower = html.toLowerCase();
  const openToken = `<${tagName}`;
  const closeToken = `</${tagName}`;
  let cursor = 0;
  let output = "";
  while (cursor < html.length) {
    const open = findTag(lower, openToken, cursor);
    if (open < 0) break;
    const openEnd = lower.indexOf(">", open + openToken.length);
    if (openEnd < 0) return output + html.slice(cursor, open);
    const close = findTag(lower, closeToken, openEnd + 1);
    if (close < 0) return output + html.slice(cursor, open);
    const closeEnd = lower.indexOf(">", close + closeToken.length);
    if (closeEnd < 0) return output + html.slice(cursor, open);
    output += `${html.slice(cursor, open)} `;
    cursor = closeEnd + 1;
  }
  return output + html.slice(cursor);
}

function findTag(lower, token, start) {
  let index = lower.indexOf(token, start);
  while (index >= 0) {
    const boundary = lower[index + token.length];
    if (boundary === undefined || boundary === ">" || boundary === "/" || " \t\r\n\f".includes(boundary)) return index;
    index = lower.indexOf(token, index + token.length);
  }
  return -1;
}

function decodeEntities(text) {
  return text.replace(/&(?:nbsp|amp|lt|gt|#(?:x[0-9a-f]+|\d+));/gi, (entity) => {
    const name = entity.slice(1, -1).toLowerCase();
    const named = { nbsp: " ", amp: "&", lt: "<", gt: ">" }[name];
    if (named !== undefined) return named;
    const code = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return entity;
    return String.fromCodePoint(code);
  });
}

async function readLimitedBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw cliError("Response exceeds configured size limit", "security", 4);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatBytes(chunks, total));
}

function concatBytes(chunks, total) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export { DEFAULT_TIMEOUT, PROFILES };

function endpointUrl(baseUrl, pathname) {
  let base;
  try { base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`); }
  catch { throw cliError(`Invalid SearXNG URL: ${redactUrl(baseUrl)}`, "usage", 2); }
  if (!['http:', 'https:'].includes(base.protocol)) throw cliError("SearXNG URL must use http or https", "usage", 2);
  if (base.search || base.hash) throw cliError("SearXNG URL cannot include a query or fragment", "usage", 2);
  if (typeof pathname !== "string" || /^\/\/|^[a-z][a-z0-9+.-]*:/i.test(pathname)) {
    throw cliError("SearXNG API paths must stay on the configured origin", "usage", 2);
  }
  const url = new URL(pathname.replace(/^\/+/, ""), base);
  if (url.origin !== base.origin) throw cliError("SearXNG API paths must stay on the configured origin", "usage", 2);
  return url;
}

function integerOption(value, name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw cliError(`--${name} must be an integer from ${min} to ${max}`, "usage", 2);
  }
  return number;
}

function validateCategories(config, requested) {
  const available = new Set((config.categories || []).map((category) => String(category).toLowerCase()));
  const invalid = requested.filter((category) => !available.has(category.toLowerCase()));
  if (invalid.length) throw cliError(`Unknown or disabled categories: ${invalid.join(", ")}`, "usage", 2);
}
