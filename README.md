# shein-mcp

SHEIN seller platform, exposed as a local **stdio MCP server**. Any MCP host can drive it — Orkas, Claude Code, Cursor, or anything that speaks MCP.

Manage products, prices, merchant inventory, orders, shipping, returns, certificates and finance through the SHEIN Open Platform API, for self-operated / semi-managed seller apps (application modes 1 and 5).

## What's inside

- **129 reviewed actions**: 8 hand-written legacy actions plus 121 documentation-pinned native contracts (snapshot `2026-09-30`, generated offline from official docs — never from live responses).
- **Six-umbrella tool surface**: `list_capabilities` / `describe_action` / `execute_read` / `execute_write` / `execute_high_impact` / `execute_destructive`. Every action is pinned to one lane by a reviewed risk entry (`R`/`W`/`H`/`D`); nothing discovers or widens scope at runtime.
- **Risk metadata for hosts**: every tool carries `_meta.orkas.actionPolicy` (`{risk, confirmation, maxBatchSize}`), which the Orkas host reads to apply preview / fresh / destructive confirmation — the same model used for its built-in connectors.
- **Acknowledgement semantics**: writes return `acknowledged` or `partial_or_failed` with structured failure records; submissions are never treated as review or fulfillment completion. A partial acknowledgement always tells you which resource to inspect before retrying.
- **Output sanitization**: credential values and sensitive provider fields are redacted before anything reaches the model context.

## Requirements

- Node.js 22.12+
- A SHEIN Open Platform app (self-operated / semi-managed) with the API grants you need

## Install

```bash
npm install -g .        # from this checkout, or: npm install <published-package>
npm run build
```

## Authorize (two options)

**Option A — guided exchange** (recommended first time):

```bash
# 1. Print the authorization URL and the redirect URI to register on your SHEIN app
shein-mcp authorize --app-id APPID --app-secret SECRET

# 2. Register the shown redirect URI on the SHEIN Open Platform console, open the URL,
#    approve with the shop main account; your callback receives a tempToken.

# 3. Exchange it (verifies identity, products, orders and warehouses before saving)
shein-mcp authorize --temp-token <TOKEN>
```

The grant is written to `~/.shein-mcp/credentials.json` (mode `0600`).

**Option B — manual**: complete the exchange in your own tooling and provide the grant via environment variables:

```bash
SHEIN_APP_ID=... SHEIN_APP_SECRET=... \
SHEIN_OPEN_KEY_ID=... SHEIN_SECRET_KEY=... SHEIN_SUPPLIER_ID=... \
shein-mcp serve
```

Environment variables win over the config file.

## Run

```bash
shein-mcp serve         # stdio MCP server (default command)
shein-mcp whoami        # verify the binding, print seller identity and sites
shein-mcp list-actions  # print the full reviewed action table (no network)
```

### Register with an MCP host

Orkas: **Settings → Connectors → Add custom connector**, stdio command:

```
shein-mcp serve
```

Claude Code (`claude mcp add` / `.mcp.json`):

```json
{
  "mcpServers": {
    "shein": {
      "command": "shein-mcp",
      "args": ["serve"],
      "env": { "SHEIN_APP_ID": "...", "SHEIN_APP_SECRET": "...", "SHEIN_OPEN_KEY_ID": "...", "SHEIN_SECRET_KEY": "...", "SHEIN_SUPPLIER_ID": "..." }
    }
  }
}
```

## Usage model

1. `list_capabilities` — bind check + the full action table with risk lanes.
2. `describe_action` — one action's exact parameter schema.
3. `execute_read` / `execute_write` / `execute_high_impact` / `execute_destructive` — run `{ action, parameters }`. The tool lane must match the action's reviewed risk; mismatches are rejected.

Writes may await platform review: inspect the matching status action before retrying, never replay an uncertain write automatically. Inventory overwrite (legacy `inventory.overwrite`, `POST /open-api/stock/change-inventory/v2`) requires distinct SKUs and idempotency keys, and will not reduce below reserved/occupied stock.

## Provenance & license

Adapted from the SHEIN seller adapter in the [Orkas](https://github.com/Orkas-AI/Orkas) open-source repository (MIT), including its pinned contract generation discipline and acknowledgement semantics. This repository is MIT licensed.

## Limitations

- Feed document workflows (host-owned) and other application modes' APIs are not exposed (`list_capabilities` reports them in `coverage`).
- Large uploads are capped at 256 KiB inline parameters; multipart uploads cap at 10 minutes.
- Full API coverage is not claimed; see `coverage.other_application_methods` for documented-but-unexposed methods.
