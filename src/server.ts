/** stdio MCP server exposing the SHEIN seller platform through the six-action umbrella
 *  used by Orkas connectors. Tool definitions carry `_meta.orkas.actionPolicy` so the
 *  Orkas host applies the same confirmation lanes as for built-in connectors. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema,
  McpError, ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials } from './config.js';
import { identity, actionsFor, execute, coverageFor } from './actions/registry.js';
import { fail, type ActionSpec, type Credentials } from './types.js';

const TOOL_POLICIES: Record<string, Record<string, unknown>> = Object.freeze({
  list_capabilities: { risk: 'R', confirmation: 'none', maxBatchSize: 100 },
  describe_action: { risk: 'R', confirmation: 'none', maxBatchSize: 1 },
  execute_read: { risk: 'R', confirmation: 'none', maxBatchSize: 100 },
  execute_write: { risk: 'W', confirmation: 'preview', maxBatchSize: 25 },
  execute_high_impact: { risk: 'H', confirmation: 'fresh', maxBatchSize: 10, sensitiveOperation: 'external_or_financial_change' },
  execute_destructive: { risk: 'D', confirmation: 'destructive', maxBatchSize: 10, sensitiveOperation: 'destructive' },
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

const TOOLS = Object.freeze([
  tool('list_capabilities', 'List all exact reviewed actions available for this bound SHEIN seller account.',
    { type: 'object', properties: {}, additionalProperties: false },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  tool('describe_action', 'Describe one exact reviewed action, its parameters, and its risk lane.',
    { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  tool('execute_read', 'Execute a reviewed read action.', EXECUTE_SCHEMA,
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
  tool('execute_write', 'Execute a reviewed ordinary write after preview.', EXECUTE_SCHEMA,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
  tool('execute_high_impact', 'Execute a reviewed financial or externally visible action after fresh confirmation.', EXECUTE_SCHEMA,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true }),
  tool('execute_destructive', 'Execute a reviewed delete, void, or unschedule action after destructive confirmation.', EXECUTE_SCHEMA,
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true }),
]);

const DIAGNOSTIC_CODES = new Set([
  'credentials_missing', 'binding_mismatch', 'invalid_credentials', 'invalid_binding',
  'permission_denied', 'validation_failed', 'timeout', 'network_failed', 'rate_limit',
  'upstream_error', 'invalid_response', 'request_failed', 'E_TOOL_CALL_CANCELLED',
]);

function errorKind(error: unknown): string | undefined {
  const kind = (error as { kind?: unknown })?.kind;
  return typeof kind === 'string' && DIAGNOSTIC_CODES.has(kind) ? kind : undefined;
}

function cap(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : text;
}

async function callTool(credentials: Credentials, name: string, args: Record<string, unknown>): Promise<unknown> {
  const actions = actionsFor() as Record<string, ActionSpec>;
  if (name === 'list_capabilities') {
    const who = await identity(credentials);
    return {
      provider: 'shein',
      coverage: coverageFor(),
      identity: who,
      actions: Object.entries(actions).map(([actionName, spec]) => ({
        action: actionName, risk: spec.risk, description: spec.description,
      })),
    };
  }
  if (name === 'describe_action') {
    const actionName = String(args.action || '');
    const spec = actions[actionName];
    if (!spec) fail('validation_failed', 'Unreviewed or unknown action');
    return { provider: 'shein', action: actionName, ...spec };
  }
  const expected = name === 'execute_read' ? 'R'
    : name === 'execute_write' ? 'W'
    : name === 'execute_high_impact' ? 'H'
    : name === 'execute_destructive' ? 'D' : '';
  if (!expected) fail('validation_failed', 'Unknown tool');
  const actionName = String(args.action || '');
  const spec = actions[actionName];
  if (!spec) fail('validation_failed', 'Unreviewed or unknown action');
  if (spec.risk !== expected) fail('validation_failed', `Action risk mismatch: ${actionName} is ${spec.risk}`);
  const parameters = (args.parameters ?? {}) as Record<string, unknown>;
  const result = await execute(credentials, actionName, parameters);
  return { provider: 'shein', action: actionName, risk: spec.risk, result };
}

export async function serve(): Promise<void> {
  // Fail fast on missing/invalid credentials before answering anything.
  const credentials = loadCredentials();
  const server = new Server(
    { name: 'shein-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, unknown>;
    try {
      const result = await callTool(credentials, name, args);
      return {
        content: [{ type: 'text', text: cap(JSON.stringify(result, null, 2)) }],
        isError: false,
      };
    } catch (error) {
      if (error instanceof McpError) throw error;
      const message = error instanceof Error ? error.message : 'Unknown SHEIN failure';
      return {
        content: [{ type: 'text', text: message }],
        isError: true,
        ...(errorKind(error) ? { _meta: { orkas: { errorCode: errorKind(error) } } } : {}),
      };
    }
  });
  await server.connect(new StdioServerTransport());
}
