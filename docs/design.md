# SearXNG-cli Design

## Critical review of the initial design

The initial proposal was useful but insufficient in five areas.

1. **It was too command-thin.** A single `search` plus `read` command would hide SearXNG categories, result types, suggestions, engine discovery, diagnostics, and a raw API escape hatch.
2. **It mixed mechanism and judgment.** SearXNG should aggregate engine responses; the CLI should select profiles, paginate, deduplicate, expose failures, and provide stable Agent contracts. Skills should hold task judgment and workflows.
3. **It assumed a result count was a server setting.** SearXNG pages vary by engine and availability. A final limit such as 30 requires multiple pages followed by canonical URL deduplication.
4. **It assumed categories narrow engines.** On the current instance, `categories` and `engines` are additive. Supplying both broadened technical searches with unrelated engines. Explicit profiles must send `engines` without `categories`.
5. **It under-specified security and failure semantics.** URL reading needs SSRF protection across redirects and body size limits. Partial engine failures must not masquerade as complete coverage.

The revised design treats the CLI as an Agent capability platform, following the strongest patterns found in `lark-cli`: quickstart help, a domain command tree, machine-readable schema, workflow shortcuts, structured envelopes, diagnostics, bundled version-aligned Skills, and a constrained raw escape hatch.

## Responsibility boundaries

### SearXNG

- Connects to search engines.
- Executes queries and returns merged engine results.
- Provides categories, languages, time ranges, safe search, suggestions, and `/config` discovery.
- Reports unresponsive engines.

### SearXNG-cli

- Selects task profiles or validates explicit engines.
- Performs controlled multi-page retrieval.
- Canonicalizes and deduplicates result URLs.
- Produces stable success and error envelopes.
- Exposes diagnostics and capability schemas.
- Reads public web pages under explicit safety limits.
- Ships Agent-readable Skills synchronized with the CLI version.

### Skills

- Decide when search, reading, comparison, or deeper research is appropriate.
- Define source quality and corroboration expectations.
- Compose several CLI calls into research workflows.
- Do not duplicate parameter schemas or engine lists owned by the CLI.

## Command model

```text
SearXNG-cli
├── search
├── read
├── suggest
├── engines
├── inspect / doctor
├── schema
├── skills list / read / install / status / update / uninstall
└── api GET
```

The current MVP uses `--mode` for task shortcuts rather than separate command implementations. Future aliases such as `+research`, `+compare`, and `+digest` should be thin translations into the same search and workflow primitives.

## Search execution

1. Resolve the endpoint.
2. Infer or validate the mode.
3. Fetch `/config` and canonicalize enabled engine names.
4. Remove unavailable engines and report them.
5. Query one or more pages sequentially.
6. Merge duplicate URLs after removing fragments and common tracking parameters.
7. Preserve multi-engine provenance on duplicates.
8. Truncate to the requested final result count.
9. Return failures and a `partial` coverage flag.

The default final limit is 30. It is a CLI aggregation limit, not a promise that every query can produce 30 unique results.

Endpoint configuration is owned by this CLI. Runtime operation does not read Codex configuration, start an MCP server, or depend on any MCP package.

## Output and exit behavior

- Success: JSON envelope on stdout, exit `0`.
- Usage error: JSON error on stderr, exit `2`.
- Endpoint/network error: exit `3`.
- Security rejection: exit `4`.
- Timeout or recoverable partial transport failure: exit `5` when no useful result can be returned.
- Partial engine failures with useful results remain exit `0` and set `partial: true`.

## Skill packaging

Skills are package files exposed and explicitly managed through:

```bash
SearXNG-cli skills list
SearXNG-cli skills read searxng-web-research
SearXNG-cli skills install --target codex
SearXNG-cli skills status --target both
```

This mirrors `lark-cli`'s version-aligned discovery pattern. Installation is explicit, atomic, and ownership-marked; an npm install never silently mutates global Agent directories. The CLI remains the authoritative source for schemas, flags, engine availability, and examples.

## Deferred work

- Better DOM-aware readability extraction.
- Streaming NDJSON metadata records.
- Persistent response cache with explicit freshness policy.
- Query plans for source comparison and fact checking.
- Optional multiple SearXNG endpoints with failover/fanout.
- Eval fixtures for routing quality, source diversity, and coverage reporting.
