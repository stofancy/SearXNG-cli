---
name: searxng-web-research
description: "Conduct multi-query web research with SearXNG-cli, source comparison, corroboration, and coverage reporting. Use for broad or high-confidence research questions that require several searches and reading multiple sources."
---

# Web Research

For research tasks, run several focused `SearXNG-cli search` calls rather than one huge query. Use `--mode` for the source class, keep `--limit 30`, deduplicate URLs, then use `SearXNG-cli read` on the strongest sources.

Report the search mode, source coverage, failed engines, publication dates, and disagreements. Do not claim that a search is exhaustive merely because SearXNG returned results.
