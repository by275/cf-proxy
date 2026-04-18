# cf-proxy

Proxy TCP traffic through Cloudflare Workers and expose it locally as an HTTP proxy, SOCKS5 proxy, or both on one port.

This repo has two parts:

- `worker/`: the Cloudflare Worker that accepts authenticated WebSocket upgrades and opens outbound sockets with `cloudflare:sockets`
- `proxy.js`: the local Bun-based proxy server that speaks HTTP CONNECT and/or SOCKS5, then forwards traffic through one or more deployed workers

## What Changed From The Old Flow

The current project no longer expects you to hardcode a token inside `worker/src/index.js`.

- Worker authentication is configured with the `PROXY_AUTH_TOKEN` secret
- Worker behavior is configured with Worker env vars such as `PROXY_CONNECT_TIMEOUT_MS`
- The local proxy can spread traffic across multiple workers
- The local proxy supports per-target routing policies, retries, cooldowns, and optional direct fallback
- `deploy.sh` can deploy multiple worker instances in one command

## Requirements

- [Bun](https://bun.sh/) for the local proxy client
- A Cloudflare account
- Wrangler access via `npx wrangler` inside `worker/`

Install Bun if needed:

```bash
curl -fsSL https://bun.sh/install | bash
. ~/.bashrc
```

Install the Worker dependencies:

```bash
cd worker
npm install
```

Authenticate Wrangler with Cloudflare:

```bash
npx wrangler login
```

## Worker Setup

The Worker reads its base name from [`worker/wrangler.toml`](/home/chulwoo/dev/by275/cf-proxy/worker/wrangler.toml).

Current defaults:

```toml
name = "cf-proxy"
main = "src/index.js"
compatibility_date = "2024-01-03"
```

### Required secret

Set the authorization token that the local proxy will send as the `Authorization` header:

```bash
cd worker
npx wrangler deploy
printf '%s' 'your-secret-token' | npx wrangler secret put PROXY_AUTH_TOKEN
```

The Worker rejects requests when:

- `PROXY_AUTH_TOKEN` is missing
- `Authorization` does not match
- the request is not a WebSocket upgrade
- `X-Proxy-Target` is missing or invalid
- the target is `localhost`, `::1`, or a private IPv4 address

### Optional Worker env vars

You can define these in Cloudflare or add them to `wrangler.toml` if you want fixed defaults:

- `PROXY_CONNECT_TIMEOUT_MS`: upstream connect timeout, default `10000`
- `PROXY_IDLE_TIMEOUT_MS`: idle timeout, default `30000`
- `PROXY_VERBOSE_LOGS`: set to `true` or `1` for more Worker-side logs
- `PROXY_TARGET_POLICIES`: JSON object for per-target Worker policy overrides

Example:

```json
{
  "*": { "idleTimeoutMs": 30000 },
  "example.com": { "idleTimeoutMs": 60000 },
  "blocked.example": { "allow": false }
}
```

## Deploying Workers

### Single worker

```bash
cd worker
npx wrangler deploy
printf '%s' 'your-secret-token' | npx wrangler secret put PROXY_AUTH_TOKEN
```

### Multiple workers with `deploy.sh`

[`deploy.sh`](/home/chulwoo/dev/by275/cf-proxy/deploy.sh) reads the base Worker name from `worker/wrangler.toml` and deploys suffixed workers like `cf-proxy-1`, `cf-proxy-2`, `cf-proxy-3`.

If `PROXY_AUTH_TOKEN` is present in your shell, it also runs `wrangler secret put PROXY_AUTH_TOKEN` for each deployed Worker.

Examples:

```bash
./deploy.sh 3
PROXY_AUTH_TOKEN='your-secret-token' ./deploy.sh 5
```

## Running The Local Proxy

Show the built-in help:

```bash
bun proxy.js --help
```

Current CLI shape:

```bash
bun proxy.js [options] -l <listen-uri> <worker[,worker2,...]>
```

Examples:

```bash
bun proxy.js -a your-secret-token -l socks://0.0.0.0:1080 cf-proxy-1.your-subdomain.workers.dev
```

```bash
bun proxy.js -a your-secret-token -l http://0.0.0.0:8080 cf-proxy-1.your-subdomain.workers.dev
```

```bash
bun proxy.js -vv -a your-secret-token -l socks+http://0.0.0.0:8923 \
  cf-proxy-1.your-subdomain.workers.dev,cf-proxy-2.your-subdomain.workers.dev
```

### Listen URI examples

- `http://0.0.0.0:8080`: HTTP proxy only
- `socks://0.0.0.0:1080`: SOCKS5 proxy only
- `socks+http://0.0.0.0:8923`: accept both protocols on the same port

### Important options

- `-a, --auth`: value sent as the Worker `Authorization` header
- `-l, --listen`: listen URI
- `--connect-timeout-ms`: client-side Worker connect timeout, default `10000`
- `--idle-timeout-ms`: idle timeout for proxied connections, default `30000`
- `--connect-retries`: retry failed Worker connections, default `workers - 1`
- `--worker-cooldown-ms`: temporarily avoid a failed Worker, default `30000`
- `--max-connections-per-worker`: concurrent connection cap per Worker, default `32`
- `--max-pending-bytes`: queued client data limit before upstream opens, default `1048576`
- `--routing-policy-file`: JSON file with per-target routing rules
- `--routing-policy-json`: inline JSON with per-target routing rules
- `--json-log`: emit machine-readable logs
- `-v`: show connect/open/close logs
- `-vv, --verbose`: show more of the connection lifecycle

## Routing Policies

The local proxy supports per-target routing decisions keyed by hostname. Policies can be provided through `--routing-policy-file` or `--routing-policy-json`.

Supported keys:

- `mode`: `worker` or `direct`
- `fallback`: `worker` or `direct`
- `preferredWorkers`: ordered list of preferred worker hostnames

Example file:

```json
{
  "*": {
    "mode": "worker",
    "fallback": "direct"
  },
  "api.example.com": {
    "preferredWorkers": [
      "cf-proxy-2.your-subdomain.workers.dev",
      "cf-proxy-1.your-subdomain.workers.dev"
    ]
  },
  "intranet.example": {
    "mode": "direct"
  }
}
```

Run with it:

```bash
bun proxy.js -a your-secret-token \
  -l socks+http://0.0.0.0:8923 \
  --routing-policy-file ./routing-policy.json \
  cf-proxy-1.your-subdomain.workers.dev,cf-proxy-2.your-subdomain.workers.dev
```

## Usage Examples

HTTP proxy test:

```bash
curl -x http://127.0.0.1:8080 https://myip.wtf/json
```

If you started a mixed listener on `8923`, many tools can use either HTTP proxy mode or SOCKS5 mode against the same port, depending on what they support.

## Limits And Notes

- Cloudflare Workers do not allow every outbound destination and port. Port `25` is commonly blocked.
- The Worker rejects loopback and private IPv4 targets by design.
- Accessing services behind Cloudflare from inside Cloudflare can still be awkward depending on the target.
- IP rotation behavior depends on Cloudflare's Worker scheduling and is not guaranteed per request, even though traffic may egress from different locations over time.
- This project is best suited for proxying interactive traffic, not large long-lived bulk transfers.

## Files

- [`proxy.js`](/home/chulwoo/dev/by275/cf-proxy/proxy.js): local Bun proxy entrypoint
- [`worker/src/index.js`](/home/chulwoo/dev/by275/cf-proxy/worker/src/index.js): Cloudflare Worker implementation
- [`worker/wrangler.toml`](/home/chulwoo/dev/by275/cf-proxy/worker/wrangler.toml): Worker config
- [`deploy.sh`](/home/chulwoo/dev/by275/cf-proxy/deploy.sh): multi-worker deployment helper

## Disclaimer

This project is for educational and operational experimentation purposes. You are responsible for how you deploy and use it.
