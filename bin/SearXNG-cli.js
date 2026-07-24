#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((error) => {
  const result = {
    ok: false,
    error: {
      type: error.type || "internal",
      message: error.message || String(error),
      retryable: Boolean(error.retryable),
    },
  };
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = error.exitCode || 1;
});
