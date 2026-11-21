/** stdio MCP server exposing the SHEIN seller platform through the six-action umbrella
 *  used by Orkas connectors. Tool definitions carry `_meta.orkas.actionPolicy` so the
 *  Orkas host applies the same confirmation lanes as for built-in connectors.
 *
 *  Hardening per ADR-0008 (this server is an operations tool, not a data pipeline):
 *   - lane allowlist: only the tools whose lane is enabled by SHEIN_MCP_LANES are
 *     listed and callable (default: read-only). Direct calls to disabled tools fail
 *     with `validation_failed` naming the enabled lanes;
 *   - execute_destructive needs two switches: the destructive lane AND
 *     SHEIN_MCP_ALLOW_DESTRUCTIVE=1;
 *   - batch limits declared in actionPolicy are ENFORCED server-side: each array in the
 *     parameters (at any nesting depth) and the total across all arrays are capped at
 *     the calling tool's maxBatchSize;
 *   - every execute_* call is appended to a local audit JSONL — success, error, or
 *     lane rejection — with parameter keys and a digest only, never values. Audit
 *     failures fail-close write lanes and above; reads continue with a warning;
 *   - startup self-checks: SDK validator module resolvable, credential file mode 0600
 *     (POSIX), policy combination valid. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials } from './config.js';
import { identity, actionsFor, execute, coverageFor } from './actions/registry.js';
import { probeValidator } from './validate.js';
import {
  parsePolicy, toolEnabled, actionAvailable, disabledToolMessage,
  type Policy, type ToolName,
} from './policy.js';
import {
  buildAuditRecord, createAuditSink, type AuditSink, type AuditRecordInput,
} from './audit.js';
import { fail, type ActionSpec, type Credentials } from './types.js';

type Risk = 'R' | 'W' | 'H' | 'D';

const TOOL_POLICIES: Record<string, Record<string, unknown>> = Object.freeze({
  list_capabilities: { risk: 'R', confirmation: 'none', maxBatchSize: 100 },
  describe_action: { risk: 'R', confirmation: 'none', maxBatchSize: 1 },
  execute_read: { risk: 'R', confirmation: 'none', maxBatchSize: 100 },
  execute_write: { risk: 'W', confirmation: 'preview', maxBatchSize: 25 },
  execute_high_impact: { risk: 'H', confirmation: 'fresh', maxBatchSize: 10, sensitiveOperation: 'external_or_financial_change' },
  execute_destructive: { risk: 'D', confirmation: 'destructive', maxBatchSize: 10, sensitiveOperation: 'destructive' },
});

const EXECUTE_TOOLS: Record<string, Risk> = Object.freeze({
  execute_read: 'R',
  execute_write: 'W',
  execute_high_impact: 'H',
  execute_destructive: 'D',
});

const MAX_OUTPUT_CHARS = 1024 * 1024;

const EXECUTE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: { type: 'string', maxLength: 160 },
    parameters: { type: 'object', additionalProperties: true },
  },
  required: ['action'],
  additionalProperties: false,
});

function tool(name: string, description: string, schema: Record<string, unknown>,
  annotations: Record<string, unknown>): Record<string, unknown> {
  return {
    name, description, inputSchema: schema, annotations,
    _meta: { orkas: { actionPolicy: TOOL_POLICIES[name] } },
  };
}

const ALL_TOOLS = Object.freeze([
  tool('list_capabilities', 'List all exact reviewed actions available for this bound SHEIN seller account.',
    { type: 'object', properties: {}, additionalProperties: false },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  tool('describe_action', 'Describe one exact reviewed action, its parameters, and its risk lane.',
    { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  tool('execute_read', 'Execute a reviewed read action.',
    EXECUTE_SCHEMA, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
  tool('execute_write', 'Execute a reviewed ordinary write after preview.',
    EXECUTE_SCHEMA, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
  tool('execute_high_impact', 'Execute a reviewed financial or externally visible action after fresh confirmation.',
    EXECUTE_SCHEMA, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
  tool('execute_destructive', 'Execute a reviewed delete, void, or unschedule action after destructive confirmation.',
    EXECUTE_SCHEMA, { readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
]);

const DIAGNOSTIC_CODES = new Set([
  'credentials_missing', 'binding_mismatch', 'invalid_credentials', 'invalid_binding',
  'permission_denied', 'validation_failed', 'timeout', 'network_failed', 'rate_limit',
  'upstream_error', 'invalid_response', 'request_failed', 'audit_unavailable',
  'policy_invalid', 'E_TOOL_CALL_CANCELLED',
]);

function errorKind(error: unknown): string | undefined {
  // `kind` is SheinError's field; some paths (validate.ts) tag errors with `code`.
  for (const field of ['kind', 'code']) {
    const kind = (error as Record<string, unknown>)?.[field];
    if (typeof kind === 'string' && DIAGNOSTIC_CODES.has(kind)) return kind;
  }
  return undefined;
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : text;
}

/** Batch limit enforcement (server-side, not just declared in actionPolicy):
 *  1. every array in the parameters — at any nesting depth — must carry at most
 *     `maxBatchSize` elements (flattened, so nested sub-arrays cannot hide entries);
 *  2. the total count of non-array entries across ALL arrays must stay within the same
 *     limit, so a batch cannot be split into several sub-arrays to slip past rule 1.
 *     Array wrappers themselves are not counted, so nesting a list inside a list does
 *     not inflate the total.
 *  Rejections never echo parameter content. */
export function checkBatchSize(parameters: unknown, maxBatchSize: number): void {
  let offender: { path: string; count: number } | null = null;
  let totalEntries = 0;
  const walk = (value: unknown, pathString: string): void => {
    if (offender) return;
    if (Array.isArray(value)) {
      totalEntries += value.filter((item) => !Array.isArray(item)).length;
      const flattened = value.flat(Infinity).length;
      if (flattened > maxBatchSize) {
        offender = { path: pathString, count: flattened };
        return;
      }
      value.forEach((item, index) => walk(item, `${pathString}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, pathString ? `${pathString}.${key}` : key);
    }
  };
  walk(parameters, 'parameters');
  if (!offender && totalEntries > maxBatchSize) {
    offender = { path: 'parameters (total across all arrays)', count: totalEntries };
  }
  if (offender) {
    fail('validation_failed',
      `Batch too large for this tool: field "${offender.path}" carries ${offender.count} `
      + `entries against a server-side limit of ${maxBatchSize}. Split the batch across calls.`);
  }
}

/** One execute_* attempt, fully resolved into a payload + optional audit line.
 *  Server-side refusals (lane, batch, unknown action, audit pre-flight) come back as
 *  `isError` payloads with outcome `rejected`; execution failures with outcome `error`;
 *  successes with outcome `ok`. Every execute_* attempt produces exactly one audit line. */
interface ToolOutcome {
  payload: unknown;
  isError: boolean;
  errorCode?: string;
  audit?: AuditRecordInput;
  /** The log is already known broken (audit_unavailable rejection) — don't try to append. */
  skipAuditAppend?: boolean;
}

function rejected(message: string, errorCode: string,
  extra: Record<string, unknown> = {}): ToolOutcome {
  return {
    payload: { rejected: true, reason: errorCode, message, ...extra },
    isError: true,
    errorCode,
  };
}

async function callTool(credentials: Credentials, policy: Policy, auditSink: AuditSink | null,
  name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const actions = actionsFor() as Record<string, ActionSpec>;
  const supplierId = credentials.identity.supplier_id;

  if (!TOOL_POLICIES[name]) fail('validation_failed', 'Unknown tool');

  // Lane gate: disabled tools are never listed; direct calls are rejected with the
  // current lane set and audited.
  if (!toolEnabled(name as ToolName, policy)) {
    const message = disabledToolMessage(name as ToolName, policy);
    const toolRisk = (EXECUTE_TOOLS[name] ?? 'R') as string;
    return {
      ...rejected(message, 'validation_failed', { tool: name }),
      audit: {
        tool: name, action: args.action, risk: toolRisk,
        outcome: 'rejected', errorCode: 'validation_failed',
        parameters: args.parameters, supplierId,
      },
    };
  }

  if (name === 'list_capabilities') {
    const who = await identity(credentials);
    return {
      payload: {
        provider: 'shein',
        coverage: coverageFor(),
        lanes: {
          enabled: [...policy.lanes],
          destructive_armed: policy.allowDestructive,
          env: policy.env,
          audit: policy.auditOff ? 'off' : 'on',
        },
        identity: who,
        actions: Object.entries(actions).map(([actionName, spec]) => ({
          action: actionName, risk: spec.risk, description: spec.description,
          available: actionAvailable(spec.risk, policy) ? 'available' : 'lane_disabled',
        })),
      },
      isError: false,
    };
  }
  if (name === 'describe_action') {
    const actionName = String(args.action || '');
    const spec = actions[actionName];
    if (!spec) fail('validation_failed', 'Unreviewed or unknown action');
    return {
      payload: {
        provider: 'shein', action: actionName, ...spec,
        available: actionAvailable(spec.risk, policy) ? 'available' : 'lane_disabled',
      },
      isError: false,
    };
  }

  // execute_* path: every refusal below is audited with outcome `rejected`.
  const expected = EXECUTE_TOOLS[name];
  const actionName = String(args.action || '');
  const parameters = (args.parameters ?? {}) as Record<string, unknown>;
  const auditBase = {
    tool: name, action: actionName, risk: expected,
    parameters, supplierId,
  };

  const spec = actions[actionName];
  if (!spec) {
    return {
      ...rejected('Unreviewed or unknown action', 'validation_failed', { action: actionName }),
      audit: { ...auditBase, outcome: 'rejected', errorCode: 'validation_failed' },
    };
  }
  if (spec.risk !== expected) {
    return {
      ...rejected(`Action risk mismatch: ${actionName} is ${spec.risk}`, 'validation_failed', { action: actionName }),
      audit: { ...auditBase, outcome: 'rejected', errorCode: 'validation_failed' },
    };
  }
  // Server-side batch limit for this tool's lane.
  const maxBatchSize = Number(TOOL_POLICIES[name].maxBatchSize);
  try {
    checkBatchSize(parameters, maxBatchSize);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Batch too large';
    return {
      ...rejected(message, 'validation_failed', { action: actionName }),
      audit: { ...auditBase, outcome: 'rejected', errorCode: 'validation_failed' },
    };
  }

  // Fail-closed: write lanes and above require a writable audit log before executing.
  if (expected !== 'R' && !policy.auditOff) {
    const probe = auditSink?.probe();
    if (!probe?.ok) {
      const message = `Local audit log is not writable${probe?.error ? `: ${probe.error}` : ''}; `
        + 'write and higher-impact calls are blocked. Fix the audit log path '
        + '(SHEIN_MCP_AUDIT_LOG) or its permissions, then retry.';
      return {
        ...rejected(message, 'audit_unavailable', { tool: name, action: actionName }),
        audit: { ...auditBase, outcome: 'rejected', errorCode: 'audit_unavailable' },
        skipAuditAppend: true, // the log is known broken; appending would only fail again
      };
    }
  }

  try {
    const result = await execute(credentials, actionName, parameters);
    return {
      payload: { provider: 'shein', action: actionName, risk: spec.risk, result },
      isError: false,
      audit: { ...auditBase, outcome: 'ok' },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown SHEIN failure';
    return {
      payload: { provider: 'shein', action: actionName, risk: expected, error: message },
      isError: true,
      errorCode: errorKind(error) ?? 'request_failed',
      audit: { ...auditBase, outcome: 'error', errorCode: errorKind(error) ?? null },
    };
  }
}

export async function serve(): Promise<void> {
  // Fail fast on invalid policy combinations before touching credentials or SHEIN.
  const policy = parsePolicy();
  // Startup self-check: the deep SDK import used for native validation must resolve,
  // otherwise every native action would crash on first use.
  probeValidator();
  // Fail fast on missing/invalid credentials before answering anything.
  const credentials = loadCredentials();
  const auditSink = policy.auditOff ? null : createAuditSink(policy.auditPath);
  const server = new Server(
    { name: 'shein-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.filter((entry) => toolEnabled(entry.name as ToolName, policy)),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, unknown>;
    let outcome: ToolOutcome;
    try {
      outcome = await callTool(credentials, policy, auditSink, name, args);
    } catch (error) {
      if (error instanceof McpError) throw error;
      const kind = errorKind(error);
      const message = error instanceof Error ? error.message : 'Unknown SHEIN failure';
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
        ...(kind ? { _meta: { orkas: { errorCode: kind } } } : {}),
      };
    }
    // Audit append: reads fail open with a `audit_warning` field; write lanes and above
    // fail closed with `audit_unavailable`.
    let auditWarning: string | undefined;
    if (outcome.audit && !outcome.skipAuditAppend) {
      const record = buildAuditRecord(outcome.audit);
      const appended = auditSink?.append(record);
      if (appended && !appended.ok) {
        const message = `Local audit log is not writable${appended.error ? `: ${appended.error}` : ''}`;
        if (outcome.audit.risk === 'R') {
          auditWarning = message;
        } else {
          return {
            content: [{ type: 'text', text: message }],
            isError: true,
            _meta: { orkas: { errorCode: 'audit_unavailable' } },
          };
        }
      }
    }
    let payload = outcome.payload;
    if (auditWarning && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      payload = { ...(payload as Record<string, unknown>), audit_warning: auditWarning };
    }
    return {
      content: [{ type: 'text', text: cap(JSON.stringify(payload, null, 2)) }],
      isError: outcome.isError,
      ...(outcome.isError && outcome.errorCode
        ? { _meta: { orkas: { errorCode: outcome.errorCode } } } : {}),
    };
  });
  await server.connect(new StdioServerTransport());
}
