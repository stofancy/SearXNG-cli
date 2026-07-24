# SearXNG-cli

[![CI](https://github.com/stofancy/SearXNG-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/stofancy/SearXNG-cli/actions/workflows/ci.yml)
[![CodeQL](https://github.com/stofancy/SearXNG-cli/actions/workflows/codeql.yml/badge.svg)](https://github.com/stofancy/SearXNG-cli/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](https://nodejs.org/)

Agent-first command-line client for a self-hosted [SearXNG](https://github.com/searxng/searxng) instance. It connects directly over HTTP, discovers live engine capabilities, selects engines by task, aggregates multiple result pages, and emits stable machine-readable output. No MCP server is required.

> [!IMPORTANT]
> This is an unofficial community project and is not affiliated with or endorsed by the SearXNG project.

## Why this CLI

SearXNG exposes excellent search primitives, but an Agent also needs predictable contracts: engine discovery, explicit routing, controlled pagination, URL deduplication, partial-failure evidence, safe page reading, and version-aligned workflow instructions. SearXNG-cli provides that layer while leaving actual search aggregation to SearXNG.

## Requirements

- Node.js 20 or newer.
- A reachable SearXNG instance with the `json` search format enabled.

In SearXNG `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

## Install

Until the first npm release, install from a clone:

```bash
git clone https://github.com/stofancy/SearXNG-cli.git
cd SearXNG-cli
npm install -g .
```

The package installs both `SearXNG-cli` and the lowercase alias `searxng-cli`.

## Quick start

```bash
SearXNG-cli config set-url http://127.0.0.1:8080
SearXNG-cli inspect
SearXNG-cli search --query "OpenAI Codex" --limit 30
SearXNG-cli search --query "Node.js AbortController docs" --mode tech
SearXNG-cli read --url https://example.com
```

Install the bundled Agent Skills into Codex's shared Skill directory:

```bash
SearXNG-cli skills install
SearXNG-cli skills status
```

Use `--target claude` or `--target both` for Claude-compatible Skill directories. Installation refuses to overwrite an existing directory unless it carries SearXNG-cli's ownership marker.

## Configuration

The endpoint is resolved in this order:

1. `--url`
2. `SEARXNG_CLI_URL`
3. `SEARXNG_URL`
4. `~/.config/searxng-cli/config.json`
5. `http://127.0.0.1:8080`

```bash
SearXNG-cli config set-url https://search.example.org
SearXNG-cli config show
SearXNG-cli config path
```

The CLI-owned config is created with user-only permissions on supported platforms. Credentials embedded in the endpoint are redacted from output, but environment-based secrets or a reverse proxy are preferred.

## Commands

| Command | Purpose |
| --- | --- |
| `search` | Search, paginate, deduplicate, and report incomplete engine coverage |
| `read` | Extract text from a public HTTP(S) page under SSRF and size controls |
| `suggest` | Query SearXNG autocomplete |
| `engines` | Discover enabled engines and capabilities |
| `inspect` / `doctor` | Verify reachability and inspect instance capabilities |
| `config` | Manage the CLI-owned endpoint |
| `schema` | Print machine-readable command contracts |
| `skills` | List, read, install, update, status, or uninstall bundled Agent Skills |
| `api GET <path>` | Call a read-only path on the configured SearXNG origin |

Run `SearXNG-cli --help`, `SearXNG-cli schema search`, or `SearXNG-cli <command> --help` for exact flags.

## Search routing

`--mode auto` infers one of six task profiles from the query. Explicit `--engines` replaces the profile. Explicit `--category` asks SearXNG to select engines for those categories and cannot be combined with `--engines`.

| Mode | Source intent |
| --- | --- |
| `general` | Broad web and reference sources |
| `news` | Current events and news sources |
| `tech` | Documentation, repositories, Q&A, and technical papers |
| `academic` | Scholarly indexes and papers |
| `images` | Image engines |
| `videos` | Video engines |

Profiles are capability-aware: the CLI reads `/config`, uses only enabled engines, and reports unavailable or unresponsive engines. The default `--limit 30` is a final aggregation limit, not a promise that every query will produce 30 unique results.

```bash
SearXNG-cli search --query "vector database benchmarks" --mode tech --limit 30
SearXNG-cli search --query "climate paper" --engines "arxiv,semantic scholar"
SearXNG-cli search --query "mountain landscape" --category images --format ndjson
```

## Agent Skills

The package includes four concise, version-aligned Skills:

- `searxng-web-search` — task-aware search and coverage handling.
- `searxng-web-read` — safe retrieval and text extraction.
- `searxng-web-research` — multi-query research and corroboration.
- `searxng-web-source-evaluation` — authority, freshness, and evidence assessment.

```bash
SearXNG-cli skills list
SearXNG-cli skills read searxng-web-research
SearXNG-cli skills install --target codex
SearXNG-cli skills update --target both
SearXNG-cli skills uninstall --target claude
```

Installing the npm package does not silently mutate an Agent's global Skill directory. Skill installation is an explicit, inspectable command.

## Output contract

Successes use stdout and exit `0`:

```json
{
  "ok": true,
  "data": {
    "query": "...",
    "mode": "tech",
    "requested_engines": ["brave", "github", "mdn"],
    "failed_engines": [],
    "results": [],
    "partial": false
  }
}
```

Errors use stderr and a non-zero status:

```json
{
  "ok": false,
  "error": {
    "type": "network",
    "message": "...",
    "retryable": true
  }
}
```

| Exit | Meaning |
| ---: | --- |
| `0` | Success, including useful results with `partial: true` |
| `1` | Internal error |
| `2` | Invalid command or argument |
| `3` | Endpoint, protocol, or network failure |
| `4` | Security policy rejection |
| `5` | Timeout |

Output formats: `json`, `pretty`, `ndjson`, and `csv`. `--jq <expression>` filters the JSON envelope when `jq` is installed.

## Security model

- Raw API calls are GET-only and cannot leave the configured SearXNG origin.
- `read` accepts only HTTP(S), rejects credential-bearing URLs, resolves and validates every hop, and pins each connection to its validated IP to prevent DNS rebinding.
- Private, reserved, loopback, documentation, and multicast addresses are blocked unless `--allow-private` is explicitly supplied.
- Redirect count, response size, content type, and time are bounded.
- Page text and search results are untrusted input; bundled Skills instruct Agents not to treat page content as instructions.

`--allow-private` intentionally changes the trust boundary. Use it only for a known internal URL.

## Development

```bash
npm ci
npm run check
npm test
npm run test:coverage
npm pack --dry-run
```

For live integration coverage:

```bash
SEARXNG_E2E_URL=http://127.0.0.1:8080 npm run e2e:live
```

The runtime has zero third-party dependencies. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [docs/releasing.md](docs/releasing.md) for project policy.

## License

[MIT](LICENSE). SearXNG itself is a separate project distributed under AGPL-3.0-or-later.
