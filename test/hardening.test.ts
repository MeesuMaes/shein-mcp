/** Hardening unit tests (node:test — no test framework, per ADR-0008 hardening spec).
 *  Covers: lane computation (default / with write / destructive double-switch),
 *  audit record structure (no parameter values), audit-off + read-only combination,
 *  batch-limit enforcement, and the SDK validator probe. No network, no credentials. */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

import {
  parsePolicy, toolEnabled, actionAvailable, disabledToolMessage,
} from '../src/policy.js';
import {
  buildAuditRecord, createAuditSink, parameterDigest, parameterKeys, findIdempotencyKey,
} from '../src/audit.js';
import { checkBatchSize } from '../src/server.js';
import { probeValidator } from '../src/validate.js';
import { SheinError } from '../src/types.js';

const env = (overrides: Record<string, string>): NodeJS.ProcessEnv => ({ ...overrides });

// --- lane computation -------------------------------------------------------------

test('default policy is read-only with audit on, test env', () => {
  const policy = parsePolicy(env({}));
  assert.deepEqual(policy.lanes, ['read']);
  assert.equal(policy.allowDestructive, false);
  assert.equal(policy.env, 'test');
  assert.equal(policy.auditOff, false);
  assert.equal(policy.auditPath, path.join(os.homedir(), '.shein-mcp', 'audit.jsonl'));
});

test('default tools: only the three read tools are enabled', () => {
  const policy = parsePolicy(env({}));
  assert.equal(toolEnabled('list_capabilities', policy), true);
  assert.equal(toolEnabled('describe_action', policy), true);
  assert.equal(toolEnabled('execute_read', policy), true);
  assert.equal(toolEnabled('execute_write', policy), false);
  assert.equal(toolEnabled('execute_high_impact', policy), false);
  assert.equal(toolEnabled('execute_destructive', policy), false);
});

test('SHEIN_MCP_LANES=read,write enables execute_write but not higher lanes', () => {
  const policy = parsePolicy(env({ SHEIN_MCP_LANES: 'read,write' }));
  assert.deepEqual(policy.lanes, ['read', 'write']);
  assert.equal(toolEnabled('execute_write', policy), true);
  assert.equal(toolEnabled('execute_high_impact', policy), false);
  assert.equal(toolEnabled('execute_destructive', policy), false);
});

test('destructive lane alone does not arm execute_destructive (double switch required)', () => {
  const policy = parsePolicy(env({ SHEIN_MCP_LANES: 'read,destructive' }));
  assert.ok(policy.lanes.includes('destructive'));
  assert.equal(policy.allowDestructive, false);
  assert.equal(toolEnabled('execute_destructive', policy), false);
  assert.match(disabledToolMessage('execute_destructive', policy), /SHEIN_MCP_ALLOW_DESTRUCTIVE/);
});

test('destructive double switch arms execute_destructive', () => {
  const policy = parsePolicy(env({ SHEIN_MCP_LANES: 'read,destructive', SHEIN_MCP_ALLOW_DESTRUCTIVE: '1' }));
  assert.equal(policy.allowDestructive, true);
  assert.equal(toolEnabled('execute_destructive', policy), true);
  assert.equal(actionAvailable('D', policy), true);
});

test('action availability follows lanes: D action unavailable without the double switch', () => {
  const policy = parsePolicy(env({ SHEIN_MCP_LANES: 'read,write,high_impact' }));
  assert.equal(actionAvailable('R', policy), true);
  assert.equal(actionAvailable('W', policy), true);
  assert.equal(actionAvailable('H', policy), true);
  assert.equal(actionAvailable('D', policy), false);
});

test('unknown lane value is rejected with policy_invalid', () => {
  assert.throws(() => parsePolicy(env({ SHEIN_MCP_LANES: 'read,delete' })),
    (error: unknown) => error instanceof SheinError && error.kind === 'policy_invalid');
});

test('SHEIN_MCP_ALLOW_DESTRUCTIVE must be exactly "1"', () => {
  assert.throws(() => parsePolicy(env({ SHEIN_MCP_LANES: 'read,destructive', SHEIN_MCP_ALLOW_DESTRUCTIVE: 'yes' })),
    (error: unknown) => error instanceof SheinError && error.kind === 'policy_invalid');
});

test('SHEIN_MCP_ENV must be test or prod', () => {
  assert.throws(() => parsePolicy(env({ SHEIN_MCP_ENV: 'staging' })),
    (error: unknown) => error instanceof SheinError && error.kind === 'policy_invalid');
});

// --- audit-off + read-only combination ---------------------------------------------

test('audit off is allowed for read-only lanes', () => {
  const policy = parsePolicy(env({ SHEIN_MCP_AUDIT_LOG: 'off' }));
  assert.equal(policy.auditOff, true);
});

test('audit off with any write lane is rejected at startup', () => {
  assert.throws(() => parsePolicy(env({ SHEIN_MCP_AUDIT_LOG: 'off', SHEIN_MCP_LANES: 'read,write' })),
    (error: unknown) => error instanceof SheinError && error.kind === 'policy_invalid');
  assert.throws(() => parsePolicy(env({ SHEIN_MCP_AUDIT_LOG: 'off', SHEIN_MCP_LANES: 'read,destructive', SHEIN_MCP_ALLOW_DESTRUCTIVE: '1' })),
    (error: unknown) => error instanceof SheinError && error.kind === 'policy_invalid');
});

test('prod requires the audit log', () => {
  assert.throws(() => parsePolicy(env({ SHEIN_MCP_ENV: 'prod', SHEIN_MCP_AUDIT_LOG: 'off' })),
    (error: unknown) => error instanceof SheinError && error.kind === 'policy_invalid');
});

test('prod refuses a half-armed destructive lane', () => {
  assert.throws(() => parsePolicy(env({ SHEIN_MCP_ENV: 'prod', SHEIN_MCP_LANES: 'read,destructive' })),
    (error: unknown) => error instanceof SheinError && error.kind === 'policy_invalid');
  const armed = parsePolicy(env({ SHEIN_MCP_ENV: 'prod', SHEIN_MCP_LANES: 'read,destructive', SHEIN_MCP_ALLOW_DESTRUCTIVE: '1' }));
  assert.equal(armed.env, 'prod');
});

test('audit path override is honored', () => {
  const policy = parsePolicy(env({ SHEIN_MCP_AUDIT_LOG: '/tmp/shein-audit.jsonl' }));
  assert.equal(policy.auditPath, '/tmp/shein-audit.jsonl');
  assert.equal(policy.auditOff, false);
});

// --- audit record structure ---------------------------------------------------------

const SUPPLIER = '12345';

const SECRET_PARAMS = {
  body: {
    sku_code: 'SKU-1',
    app_secret: 'super-secret-value',
    nested: { items: [{ sku_code: 'A' }, { sku_code: 'B' }], secret_key: 'another-secret' },
  },
  query: { page: 3 },
};

test('audit record carries keys and digest, never parameter values', () => {
  const record = buildAuditRecord({
    tool: 'execute_write', action: 'some.write', risk: 'W',
    outcome: 'ok', parameters: SECRET_PARAMS, supplierId: SUPPLIER,
  });
  const serialized = JSON.stringify(record);
  assert.ok(serialized.includes('"ts"'));
  assert.ok(serialized.includes('"tool":"execute_write"'));
  assert.ok(serialized.includes('"action":"some.write"'));
  assert.ok(serialized.includes('"risk":"W"'));
  assert.ok(serialized.includes('"outcome":"ok"'));
  assert.ok(serialized.includes('"error_code":null'));
  assert.ok(serialized.includes('"supplier_id":"12345"'));
  assert.ok(serialized.includes('"parameter_digest"'));
  // keys only, deduplicated and sorted
  assert.deepEqual(record.parameter_keys, [...new Set(record.parameter_keys)].sort());
  // no parameter values anywhere in the line
  assert.ok(!serialized.includes('super-secret-value'));
  assert.ok(!serialized.includes('another-secret'));
  assert.ok(!serialized.includes('SKU-1'));
  // no credential-like values in the digest: it is a hex sha256
  assert.match(record.parameter_digest, /^[0-9a-f]{64}$/);
});

test('parameter digest is stable under key order changes (canonical JSON)', () => {
  const a = { x: 1, body: { y: 2, z: 3 } };
  const b = { body: { z: 3, y: 2 }, x: 1 };
  assert.equal(parameterDigest(a), parameterDigest(b));
  assert.notEqual(parameterDigest(a), parameterDigest({ x: 2, body: { y: 2, z: 3 } }));
});

test('parameter keys are capped at 40, deduplicated, sorted', () => {
  const big: Record<string, unknown> = {};
  for (let i = 0; i < 60; i++) big[`field_${String(i).padStart(2, '0')}`] = i;
  const keys = parameterKeys(big);
  assert.equal(keys.length, 40);
  assert.deepEqual(keys, [...keys].sort());
  // repeated keys across depths collapse into one
  const keys2 = parameterKeys({ a: { b: { c: 1 } }, d: { c: 2, e: { b: 3 } } });
  assert.deepEqual(keys2, ['a', 'b', 'c', 'd', 'e']);
});

test('idempotency key is recorded when present, at any depth', () => {
  assert.equal(findIdempotencyKey({ body: { idempotencyKey: 'op-42' } }), 'op-42');
  assert.equal(findIdempotencyKey({ request_key: 'rk-1' }), 'rk-1');
  assert.equal(findIdempotencyKey({ body: { items: [{ sku_code: 'A', idempotency_key: 'id-9' }] } }), 'id-9');
  assert.equal(findIdempotencyKey({ body: { nope: 1 } }), null);
  const record = buildAuditRecord({
    tool: 'execute_high_impact', action: 'x', risk: 'H', outcome: 'ok',
    parameters: { body: { idempotencyKey: 'op-42' } }, supplierId: SUPPLIER,
  });
  assert.equal(record.idempotency_key, 'op-42');
});

test('rejected outcome records the error code', () => {
  const record = buildAuditRecord({
    tool: 'execute_write', action: 'x', risk: 'W', outcome: 'rejected',
    errorCode: 'validation_failed', parameters: {}, supplierId: SUPPLIER,
  });
  assert.equal(record.outcome, 'rejected');
  assert.equal(record.error_code, 'validation_failed');
});

test('audit sink appends JSONL lines; each line parses and holds no parameter values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-audit-'));
  const file = path.join(dir, 'audit.jsonl');
  const sink = createAuditSink(file);
  assert.equal(sink.probe().ok, true);
  const record = buildAuditRecord({
    tool: 'execute_write', action: 'some.write', risk: 'W', outcome: 'ok',
    parameters: SECRET_PARAMS, supplierId: SUPPLIER,
  });
  const record2 = buildAuditRecord({
    tool: 'execute_read', action: 'some.read', risk: 'R', outcome: 'ok',
    parameters: { q: 'private-query-value' }, supplierId: SUPPLIER,
  });
  assert.equal(sink.append(record).ok, true);
  assert.equal(sink.append(record2).ok, true);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['action', 'error_code', 'idempotency_key',
    'outcome', 'parameter_digest', 'parameter_keys', 'risk', 'supplier_id', 'ts', 'tool'].sort());
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(!content.includes('super-secret-value'));
  assert.ok(!content.includes('private-query-value'));
  // append-only: writing again never truncates earlier lines
  assert.equal(sink.append(record2).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('audit sink reports failure without throwing when the log cannot be created', () => {
  // A file path whose parent exists as a regular file can never host a directory:
  const blocker = path.join(os.tmpdir(), `shein-blocker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(blocker, 'not a directory');
  try {
    const sink = createAuditSink(path.join(blocker, 'sub', 'audit.jsonl'));
    const result = sink.append(buildAuditRecord({
      tool: 'execute_read', action: 'a', risk: 'R', outcome: 'ok', parameters: {}, supplierId: SUPPLIER,
    }));
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(sink.probe().ok, false);
  } finally {
    fs.rmSync(blocker, { force: true });
  }
});

// --- batch-limit enforcement ---------------------------------------------------------

const items = (n: number): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({ sku_code: `SKU-${i}`, quantity: 1 }));

test('execute_write rejects 26 entries (limit 25) and names the field, without echoing values', () => {
  assert.throws(
    () => checkBatchSize({ body: { updateSkuInventoryQuantityRequests: items(26) } }, 25),
    (error: unknown) => {
      assert.ok(error instanceof SheinError);
      assert.equal(error.kind, 'validation_failed');
      assert.ok(error.message.includes('parameters.body.updateSkuInventoryQuantityRequests'));
      assert.ok(error.message.includes('26'));
      assert.ok(error.message.includes('25'));
      assert.ok(!error.message.includes('SKU-'));
      return true;
    },
  );
});

test('execute_write accepts 25 entries', () => {
  checkBatchSize({ body: { updateSkuInventoryQuantityRequests: items(25) } }, 25);
});

test('execute_high_impact rejects 21 nested entries under body.updateSkuInventoryQuantityRequests (limit 10)', () => {
  assert.throws(
    () => checkBatchSize({ body: { updateSkuInventoryQuantityRequests: items(21) } }, 10),
    (error: unknown) => error instanceof SheinError && error.kind === 'validation_failed'
      && error.message.includes('updateSkuInventoryQuantityRequests'),
  );
});

test('splitting a batch into sub-arrays cannot bypass the limit (global total)', () => {
  // 4 arrays x 8 entries = 32 total > 25, though each single array is within 25
  const split = {
    body: {
      batch_a: items(8), batch_b: items(8), batch_c: items(8), batch_d: items(8),
    },
  };
  assert.throws(
    () => checkBatchSize(split, 25),
    (error: unknown) => error instanceof SheinError && error.kind === 'validation_failed'
      && error.message.includes('total across all arrays'),
  );
  // same total at 24 passes
  checkBatchSize({ body: { a: items(6), b: items(6), c: items(6), d: items(6) } }, 25);
});

test('deeply nested arrays are checked too', () => {
  assert.throws(
    () => checkBatchSize({ body: { x: { y: { z: [items(11)] } } } }, 10),
    (error: unknown) => error instanceof SheinError && error.kind === 'validation_failed',
  );
  checkBatchSize({ body: { x: { y: { z: [items(10)] } } } }, 10);
});

test('scalar parameters pass any limit', () => {
  checkBatchSize({ spu_code: 'X' }, 1);
  checkBatchSize({}, 1);
});

// --- SDK validator startup probe (pinned deep import) --------------------------------

test('validator probe resolves the pinned SDK deep import and validates a trivial schema', () => {
  probeValidator();
  // the exact module src/validate.ts requires:
  const require_ = createRequire(import.meta.url);
  const mod = require_('@modelcontextprotocol/sdk/validation/ajv') as {
    AjvJsonSchemaValidator: new () => { getValidator(schema: unknown): { (value: unknown): { valid: boolean } } };
  };
  const validator = new mod.AjvJsonSchemaValidator();
  assert.equal(validator.getValidator({ type: 'object' })({}).valid, true);
});

test('validator rejects a wrong-typed value (sanity: the probe is a real validator)', () => {
  const require_ = createRequire(import.meta.url);
  const mod = require_('@modelcontextprotocol/sdk/validation/ajv') as {
    AjvJsonSchemaValidator: new () => { getValidator(schema: unknown): { (value: unknown): { valid: boolean } } };
  };
  const validator = new mod.AjvJsonSchemaValidator();
  assert.equal(validator.getValidator({ type: 'object' })('not-an-object').valid, false);
});
