#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
package_file=${SEARXNG_CLI_PACKAGE:-""}
searxng_url=${SEARXNG_E2E_URL:-"http://127.0.0.1:38438"}
e2e_dir=$(mktemp -d /tmp/searxng-cli-e2e.XXXXXX)
config_file="$e2e_dir/config.json"
if [[ -z "$package_file" ]]; then
  npm pack --silent --pack-destination "$e2e_dir" >"$e2e_dir/npm-pack.log"
  package_file="$e2e_dir/$(tail -n 1 "$e2e_dir/npm-pack.log")"
fi
trap 'rm -rf "$e2e_dir"' EXIT

npm install --silent --prefix "$e2e_dir/install" "$package_file"
cli="$e2e_dir/install/node_modules/.bin/SearXNG-cli"
test -x "$cli"

run_json() {
  SEARXNG_CLI_CONFIG="$config_file" "$cli" "$@"
}

run_json config set-url "$searxng_url" >"$e2e_dir/config-set.json"
jq -e '.ok == true and .data.url != null' "$e2e_dir/config-set.json" >/dev/null
test "$(stat -c '%a' "$config_file")" = "600"

run_json inspect >"$e2e_dir/inspect.json"
jq -e '.ok == true and .data.enabled_engine_count > 0 and .data.version != null' "$e2e_dir/inspect.json" >/dev/null

run_json engines --category general >"$e2e_dir/engines.json"
jq -e '.ok == true and .data.count > 0 and ([.data.engines[].name] | index("wikipedia")) != null' "$e2e_dir/engines.json" >/dev/null

run_json schema search >"$e2e_dir/schema.json"
jq -e '.ok == true and .data.command == "search" and .data.options.limit != null' "$e2e_dir/schema.json" >/dev/null

run_json skills list >"$e2e_dir/skills.json"
jq -e '.ok == true and (.data.skills | length) == 4' "$e2e_dir/skills.json" >/dev/null
run_json skills read searxng-web-research >"$e2e_dir/web-research.md"
rg '^# Web Research$' "$e2e_dir/web-research.md" >/dev/null
run_json skills install --dir "$e2e_dir/skills" >"$e2e_dir/skills-install.json"
jq -e '.ok == true and ([.data.targets[0].skills[].status] | all(. == "current"))' "$e2e_dir/skills-install.json" >/dev/null
run_json skills uninstall --dir "$e2e_dir/skills" >"$e2e_dir/skills-uninstall.json"
jq -e '.ok == true and ([.data.targets[0].skills[].status] | all(. == "missing"))' "$e2e_dir/skills-uninstall.json" >/dev/null

run_json search --query "AbortController API documentation" --mode tech --limit 5 --pages 1 >"$e2e_dir/tech-search.json"
jq -e '.ok == true and .data.mode == "tech" and (.data.results | length) > 0 and (.data.results | length) <= 5' "$e2e_dir/tech-search.json" >/dev/null

run_json search --query "AbortController" --engines mdn --limit 5 --pages 1 >"$e2e_dir/explicit-engine.json"
jq -e '.ok == true and .data.requested_engines == ["mdn"] and ([.data.results[].engine] | all(. == "mdn"))' "$e2e_dir/explicit-engine.json" >/dev/null

run_json search --query "最新人工智能新闻" --mode auto --limit 5 --pages 1 >"$e2e_dir/auto-search.json"
jq -e '.ok == true and .data.mode == "news" and (.data.results | length) <= 5' "$e2e_dir/auto-search.json" >/dev/null

run_json search --query "AbortController" --engines mdn --limit 30 --pages 2 >"$e2e_dir/paginated-search.json"
jq -e '.ok == true and .data.pages_fetched == 2 and (.data.results | length) > 0 and (.data.results | length) <= 30 and ([.data.results[].url] | length) == ([.data.results[].url] | unique | length)' "$e2e_dir/paginated-search.json" >/dev/null

run_json suggest --query "OpenAI co" >"$e2e_dir/suggest.json"
jq -e '.ok == true and (.data | type) == "array"' "$e2e_dir/suggest.json" >/dev/null

read_args=(read --url "${SEARXNG_E2E_READ_URL:-https://example.com}" --max-chars 600)
if [[ "${SEARXNG_E2E_ALLOW_PRIVATE_READ:-0}" == "1" ]]; then
  read_args+=(--allow-private)
fi
run_json "${read_args[@]}" >"$e2e_dir/read.json"
jq -e '.ok == true and .data.title == "Example Domain" and (.data.text | length) > 0' "$e2e_dir/read.json" >/dev/null

run_json api GET /config >"$e2e_dir/raw-api.json"
jq -e '.ok == true and .data.version != null and (.data.engines | length) > 0' "$e2e_dir/raw-api.json" >/dev/null

run_json search --query "AbortController" --engines mdn --limit 2 --format ndjson >"$e2e_dir/results.ndjson"
test "$(wc -l <"$e2e_dir/results.ndjson")" -ge 1
jq -e '.url != null' "$e2e_dir/results.ndjson" >/dev/null

run_json search --query "AbortController" --engines mdn --limit 2 --format csv >"$e2e_dir/results.csv"
head -n 1 "$e2e_dir/results.csv" | rg '^rank,title,url,engine,snippet$' >/dev/null

run_json inspect --jq '.data.enabled_engine_count' >"$e2e_dir/jq.txt"
rg '^[0-9]+$' "$e2e_dir/jq.txt" >/dev/null

expect_error() {
  local expected_status=$1
  local expected_type=$2
  shift 2
  set +e
  run_json "$@" >"$e2e_dir/error-out.json" 2>"$e2e_dir/error.json"
  local actual_status=$?
  set -e
  test "$actual_status" -eq "$expected_status"
  jq -e --arg type "$expected_type" '.ok == false and .error.type == $type' "$e2e_dir/error.json" >/dev/null
}

expect_error 2 usage search --mode general
expect_error 2 usage search --query test --mode unsupported
expect_error 4 security read --url "$searxng_url"
expect_error 2 usage api GET https://example.com/config
expect_error 3 network inspect --url http://127.0.0.1:1 --timeout 500

jq -n \
  --arg temp_dir "$e2e_dir" \
  --arg version "$(jq -r '.data.version' "$e2e_dir/inspect.json")" \
  --argjson engines "$(jq '.data.enabled_engine_count' "$e2e_dir/inspect.json")" \
  --argjson tech_results "$(jq '.data.results | length' "$e2e_dir/tech-search.json")" \
  --argjson paginated_results "$(jq '.data.results | length' "$e2e_dir/paginated-search.json")" \
  '{ok:true, temp_dir:$temp_dir, searxng_version:$version, enabled_engines:$engines, tech_results:$tech_results, paginated_unique_results:$paginated_results}'
