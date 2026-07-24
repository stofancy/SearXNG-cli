# Project Agent Guide

## Scope

SearXNG-cli is a dependency-free Node.js CLI that talks directly to a user-configured SearXNG HTTP API and ships version-aligned Agent Skills. It does not use an MCP transport.

## Required checks

Run these before claiming a change is ready:

```bash
npm run check
npm test
npm pack --dry-run
```

Use `npm run e2e:live` only when a live SearXNG endpoint is available through `SEARXNG_E2E_URL`.

## Contracts

- Keep stdout machine-readable and send errors to stderr with non-zero documented exit codes.
- Treat partial engine coverage as data; do not claim exhaustive search.
- Preserve SSRF protections, redirect validation, response limits, and pinned-address reads.
- Keep runtime dependencies at zero unless a dependency materially improves correctness or security.
- Keep bundled Skills concise, namespaced with `searxng-`, and synchronized with CLI behavior.
