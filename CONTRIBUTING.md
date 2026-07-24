# Contributing

Thanks for helping improve SearXNG-cli. This is an unofficial community project and is not affiliated with the SearXNG project.

## Development

Requirements: Node.js 20 or newer and npm.

```bash
npm ci
npm run check
npm test
```

Live integration tests require a reachable SearXNG instance with JSON output enabled:

```bash
SEARXNG_E2E_URL=http://127.0.0.1:8080 npm run e2e:live
```

Some sandboxed or transparent-proxy environments resolve public domains into reserved address space. In that case, set `SEARXNG_E2E_ALLOW_PRIVATE_READ=1` only for the known E2E read target; the CLI correctly rejects such DNS answers by default.

## Pull requests

- Keep changes focused and add behavior-focused tests.
- Preserve the JSON success/error contracts and documented exit codes.
- Never weaken URL safety controls or coverage requirements to make checks pass.
- Update the README, schemas, Skills, and changelog when behavior changes.
- Use a Conventional Commit-style subject when practical, such as `fix: reject cross-origin API paths`.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
