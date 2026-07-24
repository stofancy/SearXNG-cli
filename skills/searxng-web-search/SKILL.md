---
name: searxng-web-search
description: "Search the web through SearXNG-cli with task-aware engine selection, pagination, deduplication, and structured results. Use for current facts, source discovery, targeted engine queries, or any request that requires web search through a configured SearXNG instance."
---

# Web Search

Use `SearXNG-cli search --format json` for web search. Start with `SearXNG-cli schema search` when the exact flags are unclear.

- Use `--mode auto` for ordinary queries.
- Use `--mode news`, `tech`, or `academic` when the user clearly requests that source class.
- Use `--limit 30` for research-sized searches; use `--pages` when more coverage is needed.
- Treat `failed_engines` and `partial` as evidence about coverage, not as a total failure when results exist.
- Use `--engines` only when a source-specific search is intentional.
