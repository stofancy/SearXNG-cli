import { assertSafeReadUrl, cliError } from "./policy.js";
import { cliConfigPath, enabledEngines, fetchConfig, readUrl, redactUrl, requestJson, resolveSearxngUrl, search, writeCliConfig } from "./core.js";
import { emitFailure, emitSuccess } from "./output.js";
import { listSkills, manageSkills, readSkill } from "./skills.js";

const HELP = `SearXNG-cli — Agent-first SearXNG search and web research

AGENT QUICKSTART
  SearXNG-cli search --query <text> --format json
  SearXNG-cli schema search
  SearXNG-cli engines --enabled --format json
  SearXNG-cli read --url <https-url> --format json

COMMANDS
  search       Search and aggregate SearXNG results across pages
  read         Fetch and extract readable text from a public URL
  suggest      Get autocomplete suggestions
  engines      Discover configured and enabled engines
  inspect      Check SearXNG reachability and capabilities
  config       Show or set the CLI-owned SearXNG endpoint
  schema       Print machine-readable command schemas
  skills       List, read, install, update, or uninstall Agent Skills
  api          Read-only raw SearXNG API escape hatch

SEARCH MODES
  auto (default), general, news, tech, academic, images, videos

COMMON FLAGS
  --url <url>       SearXNG base URL (or SEARXNG_URL)
  --format <kind>   json (default), pretty, ndjson, csv
  --jq <expr>       Filter the JSON envelope with jq
  --help            Show command help
`;

const SCHEMAS = {
  search: { command: "search", description: "Search and aggregate results", required: ["query"], options: { query: "string", mode: "auto|general|news|tech|academic|images|videos", engines: "comma-separated string", category: "comma-separated string", language: "string", time_range: "day|month|year", safesearch: "0|1|2", limit: "integer 1..100 (default 30)", page: "integer >= 1", pages: "integer 1..10", timeout: "milliseconds", format: "json|pretty|ndjson|csv" }, examples: ["SearXNG-cli search --query '...' --mode tech --limit 30 --format json"] },
  read: { command: "read", description: "Fetch public URL and extract readable text", required: ["url"], options: { url: "http(s) URL", max_chars: "positive integer (default 50000)", timeout: "milliseconds", allow_private: "boolean (explicit opt-in)" } },
  suggest: { command: "suggest", description: "Get SearXNG autocomplete suggestions", required: ["query"], options: { query: "string", language: "string" } },
  engines: { command: "engines", description: "Discover configured engines", options: { enabled: "boolean", category: "string", include_disabled: "boolean" } },
  inspect: { command: "inspect", description: "Check endpoint and capability health", options: { url: "string", timeout: "milliseconds" } },
  config: { command: "config", description: "Manage the CLI-owned endpoint configuration", subcommands: { show: "Show the effective redacted URL", "set-url": "Persist a SearXNG base URL", path: "Show the config file path" } },
};

export async function main(argv) {
  if (!argv.length || argv[0] === "--help" || argv[0] === "help") return process.stdout.write(HELP);
  const command = argv[0];
  if (command === "schema") return schema(argv.slice(1));
  if (command === "skills") return skills(argv.slice(1));
  const { options, positionals } = parseFlags(argv.slice(1));
  validateOptions(command, options);
  if (options.help) return process.stdout.write(commandHelp(command));
  try {
    if (command === "config") return runConfig(positionals, options);
    const url = resolveSearxngUrl(options.url);
    if (command === "search" || command.startsWith("+")) return runSearch(command, positionals, options, url);
    if (command === "read") return runRead(options);
    if (command === "suggest") return runSuggest(options, url);
    if (command === "engines") return runEngines(options, url);
    if (command === "inspect" || command === "doctor") return runInspect(options, url);
    if (command === "api") return runApi(positionals, options, url);
    throw cliError(`Unknown command: ${command}`, "usage", 2);
  } catch (error) {
    emitFailure(error);
    process.exitCode = error.exitCode || 1;
  }
}

async function runConfig(positionals, options) {
  const action = positionals[0] || "show";
  if (action === "path") return emitSuccess({ path: cliConfigPath() }, options.format, options.jq);
  if (action === "show") return emitSuccess({ url: redactUrl(resolveSearxngUrl(options.url)), path: cliConfigPath() }, options.format, options.jq);
  if (action === "set-url") {
    const value = positionals[1] || options.url;
    if (!value) throw cliError("config set-url requires a URL", "usage", 2);
    const configPath = await writeCliConfig(value);
    return emitSuccess({ url: redactUrl(value), path: configPath }, options.format, options.jq);
  }
  throw cliError(`Unknown config action: ${action}`, "usage", 2);
}

async function runSearch(command, positionals, options, url) {
  if (command.startsWith("+")) options.mode = command.slice(1);
  if (!options.query && positionals.length) options.query = positionals.join(" ");
  const data = await search(url, { ...options, timeRange: options["time-range"], validateUrl: assertSafeReadUrl });
  emitSuccess(data, options.format, options.jq);
}

async function runRead(options) {
  if (!options.url) throw cliError("--url is required for read", "usage", 2);
  const data = await readUrl(options.url, { timeout: integerFlag(options.timeout, "timeout", 15000, 1), maxChars: integerFlag(options["max-chars"], "max-chars", 50000, 1, 1000000), allowPrivate: Boolean(options["allow-private"]), validateUrl: assertSafeReadUrl });
  emitSuccess(data, options.format, options.jq);
}

async function runSuggest(options, url) {
  if (!options.query) throw cliError("--query is required for suggest", "usage", 2);
  const response = await requestJson(url, "/autocompleter", { q: options.query, language: options.language }, integerFlag(options.timeout, "timeout", 12000, 1));
  emitSuccess(response.data, options.format, options.jq);
}

async function runEngines(options, url) {
  const config = await fetchConfig(url, integerFlag(options.timeout, "timeout", 12000, 1));
  const engines = enabledEngines(config, options.category, !options["include-disabled"]);
  const data = { instance_name: config.instance_name || null, version: config.version || null, safe_search: config.safe_search, default_locale: config.default_locale, count: engines.length, engines: engines.map((engine) => ({ name: engine.name, enabled: engine.enabled !== false, shortcut: engine.shortcut, categories: engine.categories, paging: engine.paging, time_range_support: engine.time_range_support, safesearch: engine.safesearch })) };
  emitSuccess(data, options.format, options.jq);
}

async function runInspect(options, url) {
  const started = Date.now();
  const config = await fetchConfig(url, integerFlag(options.timeout, "timeout", 12000, 1));
  const data = { ok: true, url: redactUrl(url), latency_ms: Date.now() - started, instance_name: config.instance_name || null, version: config.version || null, enabled_engine_count: enabledEngines(config).length, categories: config.categories || [], safe_search: config.safe_search, default_locale: config.default_locale };
  emitSuccess(data, options.format, options.jq);
}

async function runApi(positionals, options, url) {
  const method = (positionals[0] || "GET").toUpperCase();
  const pathname = positionals[1] || "/config";
  if (method !== "GET") throw cliError("The raw escape hatch is read-only in this version", "usage", 2);
  if (!pathname.startsWith("/") || pathname.startsWith("//")) throw cliError("Raw API paths must be relative to the configured SearXNG URL", "usage", 2);
  let params = {};
  try { params = options.params ? JSON.parse(options.params) : {}; }
  catch { throw cliError("--params must be a valid JSON object", "usage", 2); }
  if (!params || Array.isArray(params) || typeof params !== "object") throw cliError("--params must be a JSON object", "usage", 2);
  const response = await requestJson(url, pathname, params, integerFlag(options.timeout, "timeout", 12000, 1));
  emitSuccess(response.data, options.format, options.jq);
}

async function schema(argv) {
  const name = argv[0];
  if (!name) return emitSuccess({ commands: Object.values(SCHEMAS) });
  if (!SCHEMAS[name]) throw cliError(`Unknown schema: ${name}`, "usage", 2);
  emitSuccess(SCHEMAS[name]);
}

async function skills(argv) {
  const action = argv[0] || "list";
  if (action === "--help" || action === "help") return process.stdout.write(commandHelp("skills"));
  if (action === "read") {
    const text = await readSkill(argv[1]);
    process.stdout.write(text);
    return;
  }
  const { options, positionals } = parseFlags(argv.slice(1));
  if (positionals.length) throw cliError(`Unexpected skills argument: ${positionals[0]}`, "usage", 2);
  const unknown = Object.keys(options).filter((key) => !["target", "dir", "format", "jq"].includes(key));
  if (unknown.length) throw cliError(`Unknown skills option(s): ${unknown.map((key) => `--${key}`).join(", ")}`, "usage", 2);
  if (action === "list") return emitSuccess({ skills: await listSkills() }, options.format, options.jq);
  emitSuccess(await manageSkills(action, options), options.format, options.jq);
}

function parseFlags(argv) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const key = token.slice(2);
    if (key === "help") { options.help = true; continue; }
    if (["enabled", "include-disabled", "allow-private", "dedupe"].includes(key)) { options[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw cliError(`Missing value for --${key}`, "usage", 2);
    options[key] = value;
  }
  if (options.q && !options.query) options.query = options.q;
  return { options, positionals };
}

function commandHelp(command) {
  if (SCHEMAS[command]) return `${SCHEMAS[command].description}\n\n${JSON.stringify(SCHEMAS[command], null, 2)}\n`;
  if (command === "skills") return "SearXNG-cli skills list|read <name>|install|update|status|uninstall [--target codex|claude|both] [--dir <path>]\n";
  return HELP;
}

function validateOptions(command, options) {
  const normalized = command.startsWith("+") ? "search" : command === "doctor" ? "inspect" : command;
  const commandOptions = {
    search: ["query", "q", "mode", "engines", "category", "language", "time-range", "safesearch", "limit", "page", "pages"],
    read: ["max-chars", "allow-private"],
    suggest: ["query", "q", "language"],
    engines: ["category", "enabled", "include-disabled"],
    inspect: [],
    config: [],
    api: ["params"],
  }[normalized];
  if (!commandOptions) return;
  const allowed = new Set([...commandOptions, "url", "timeout", "format", "jq", "help"]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length) throw cliError(`Unknown option(s): ${unknown.map((key) => `--${key}`).join(", ")}`, "usage", 2);
  if (options.format && !["json", "pretty", "ndjson", "csv"].includes(options.format)) {
    throw cliError("--format must be json, pretty, ndjson, or csv", "usage", 2);
  }
}

function integerFlag(value, name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw cliError(`--${name} must be an integer from ${min} to ${max}`, "usage", 2);
  }
  return number;
}
