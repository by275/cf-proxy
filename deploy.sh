#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$ROOT_DIR/worker"
WRANGLER_CONFIG="$WORKER_DIR/wrangler.toml"

if [[ ! -f "$WRANGLER_CONFIG" ]]; then
  echo "wrangler config not found: $WRANGLER_CONFIG" >&2
  exit 1
fi

count="${1:-}"

if [[ -z "$count" ]]; then
  read -r -p "How many workers do you want to deploy? " count
fi

if [[ ! "$count" =~ ^[1-9][0-9]*$ ]]; then
  echo "count must be a positive integer" >&2
  exit 1
fi

base_name="$(
  sed -nE 's/^[[:space:]]*name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$WRANGLER_CONFIG" | head -n 1
)"

if [[ -z "$base_name" ]]; then
  echo "could not read worker name from $WRANGLER_CONFIG" >&2
  exit 1
fi

echo "Base worker name: $base_name"
echo "Deploy count: $count"

for ((i = 1; i <= count; i++)); do
  worker_name="${base_name}-${i}"

  echo
  echo "[$i/$count] Deploying $worker_name"
  (
    cd "$WORKER_DIR"
    npx wrangler deploy --name "$worker_name"
  )

  if [[ -n "${PROXY_AUTH_TOKEN:-}" ]]; then
    echo "[$i/$count] Updating secret PROXY_AUTH_TOKEN for $worker_name"
    (
      cd "$WORKER_DIR"
      printf '%s' "$PROXY_AUTH_TOKEN" | npx wrangler secret put PROXY_AUTH_TOKEN --name "$worker_name"
    )
  else
    echo "[$i/$count] PROXY_AUTH_TOKEN is not set, skipping secret upload"
  fi
done

echo
echo "Finished deploying $count worker(s)."
