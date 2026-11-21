# shein-mcp

SHEIN seller platform, exposed as a local **stdio MCP server**. Any MCP host can drive it — Orkas, Claude Code, Cursor, or anything that speaks MCP.

Manage products, prices, merchant inventory, orders, shipping, returns, certificates and finance through the SHEIN Open Platform API, for self-operated / semi-managed seller apps (application modes 1 and 5).

## What's inside

- **129 reviewed actions**: 8 hand-written legacy actions plus 121 documentation-pinned native contracts (snapshot `2026-09-30`, generated offline from official docs — never from live responses).
- **Six-umbrella tool surface**: `list_capabilities` / `describe_action` / `execute_read` / `execute_write` / `execute_high_impact` / `execute_destructive`. Every action is pinned to one lane by a reviewed risk entry (`R`/`W`/`H`/`D`); nothing discovers or widens scope at runtime.
- **Risk metadata for hosts**: every tool carries `_meta.orkas.actionPolicy` (`{risk, confirmation, maxBatchSize}`), which the Orkas host reads to apply preview / fresh / destructive confirmation — the same model used for its built-in connectors. Batch limits are **enforced by the server**, not only declared to the host.
- **Acknowledgement semantics**: writes return `acknowledged` or `partial_or_failed` with structured failure records; submissions are never treated as review or fulfillment completion. A partial acknowledgement always tells you which resource to inspect before retrying.
- **Output sanitization**: credential values and sensitive provider fields are redacted before anything reaches the model context.

## Operating boundary (ADR-0008)

This server is an **operations tool** — inventory checks, order inspection, occasional confirmed stock or price corrections by a human operator. It is **not** a data pipeline: do not wire it into automated order flows, automated repricing loops, or anything that mutates SHEIN state without a person in the loop.

**Default is read-only (breaking change).** Out of the box only the three read tools are exposed: `list_capabilities`, `describe_action`, `execute_read`. The write, high-impact, and destructive tools are absent from `tools/list`, and calling them directly fails with `validation_failed` naming the currently enabled lanes.

To change that, set `SHEIN_MCP_LANES` (comma-separated):

| Lanes value | Tools exposed |
| --- | --- |
| *(unset)* or `read` | the three read tools |
| `read,write` | + `execute_write` |
| `read,write,high_impact` | + `execute_high_impact` |
| `read,...,destructive` | + `execute_destructive`, **only if** `SHEIN_MCP_ALLOW_DESTRUCTIVE=1` is also set |

`execute_destructive` needs **two switches**: `destructive` in `SHEIN_MCP_LANES` **and** `SHEIN_MCP_ALLOW_DESTRUCTIVE=1`. Either one alone leaves it disabled. `list_capabilities` reports the active lanes and marks every action `available` or `lane_disabled`.

**Batch limits are enforced server-side.** Each tool's `maxBatchSize` (read 100, write 25, high-impact and destructive 10) is checked against every array in the parameters — at any nesting depth — and against the total of all entries across arrays, so splitting a batch into sub-arrays does not bypass it. Oversized batches are rejected with `validation_failed` before anything is sent to SHEIN; the host no longer needs to be trusted to enforce limits.

**Local audit is mandatory for writes.** Every `execute_*` call — success, error, or lane rejection — appends one JSON line to `~/.shein-mcp/audit.jsonl` (override with `SHEIN_MCP_AUDIT_LOG`; file created `0600`, append-only). Lines record the tool, action, risk, outcome, error code, a sha256 digest of the canonicalized parameters, parameter **key names only** (max 40, deduplicated, sorted), an idempotency key if the parameters carry one, and the seller id. **Parameter values, response bodies, and credentials are never written.** If the log becomes unwritable: reads continue with an `audit_warning` field; writes and above are blocked outright (`audit_unavailable`) — fail-closed. `SHEIN_MCP_AUDIT_LOG=off` is allowed only with a read-only lane set; anything else refuses to start.

**test / prod separation.** `SHEIN_MCP_ENV` is `test` (default) or `prod`. In `prod` the audit log must be enabled (cannot be `off`), and the destructive lane cannot be half-armed: `destructive` in the lanes without `SHEIN_MCP_ALLOW_DESTRUCTIVE=1` refuses to start.

**Credential requirements.** The grant lives in `~/.shein-mcp/credentials.json`. On POSIX the file must be mode `0600` — anything wider is refused at startup with `permission_denied` (no check is performed on Windows rather than a fake one). Credentials are never written to stdout, stderr, or the audit log. Prefer env-var credentials (`SHEIN_APP_ID` etc.) for CI/sandbox runs; env always wins over the file.

## Requirements

- Node.js 22.12+
- A SHEIN Open Platform app (self-operated / semi-managed) with the API grants you need

## Install

Human install from a checkout:

```bash
npm install
npm run build
```

**For an AI agent installing this on a machine:** follow [AGENTS.md](./AGENTS.md). It is the exact sequence — clone to `~/.shein-mcp/app`, build, verify 129 actions, register the stdio server with absolute paths, then stop for the user to finish SHEIN authorization. Do not invent credentials.

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
