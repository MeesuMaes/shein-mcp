/** Local append-only JSONL audit trail per ADR-0008.
 *  One line per `execute_*` call — success, error, or lane rejection — and nothing else:
 *  no parameter values, no response bodies, no credentials. Keys only, plus a sha256
 *  digest of the canonicalized parameters for traceability.
 *
 *  Failure semantics: reads continue with a warning; write lanes and above are
 *  fail-closed (see server.ts — `audit_unavailable`), with a cheap pre-flight
 *  `probe()` so a write is blocked *before* it executes when the log is not writable. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fail } from './types.js';

const MAX_KEYS = 40;
const MAX_ACTION_CHARS = 160;

export type AuditOutcome = 'ok' | 'error' | 'rejected';

export interface AuditRecord {
  ts: string;
  tool: string;
  action: string;
  risk: string;
  outcome: AuditOutcome;
  error_code: string | null;
  parameter_digest: string;
  parameter_keys: string[];
  idempotency_key: string | null;
  supplier_id: string;
}

export interface AuditRecordInput {
  tool: string;
  action: unknown;
  risk: string;
  outcome: AuditOutcome;
  errorCode?: string | null;
  parameters?: unknown;
  supplierId: string;
}

/** Canonical JSON: object keys sorted at every depth, array order preserved. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Parameter digest: sha256 of the canonicalized parameters. Never the values. */
export function parameterDigest(parameters: unknown): string {
  return createHash('sha256').update(canonicalJson(parameters ?? {})).digest('hex');
}

/** Collect object key names at any depth (no values), deduplicated and sorted, capped. */
export function parameterKeys(parameters: unknown): string[] {
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      keys.add(key);
      walk(child);
    }
  };
  walk(parameters);
  return [...keys].sort().slice(0, MAX_KEYS);
}

const IDEMPOTENCY_FIELDS = ['idempotency_key', 'idempotencyKey', 'request_key'] as const;

/** Idempotency key, if the parameters carry one (checked at any depth).
 *  Operator-chosen keys are recorded for traceability; they are not credentials. */
export function findIdempotencyKey(parameters: unknown): string | null {
  let found: string | null = null;
  const walk = (value: unknown): void => {
    if (found !== null || Array.isArray(value)) {
      if (Array.isArray(value)) value.forEach(walk);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((IDEMPOTENCY_FIELDS as readonly string[]).includes(key) && typeof child === 'string' && child) {
        found = child;
        return;
      }
      walk(child);
    }
  };
  walk(parameters);
  return found;
}

/** Build one audit record. Pure: no filesystem, no values. */
export function buildAuditRecord(input: AuditRecordInput): AuditRecord {
  if (!input.supplierId) fail('validation_failed', 'Audit record requires the seller identity');
  return {
    ts: new Date().toISOString(),
    tool: input.tool,
    action: String(input.action ?? '').slice(0, MAX_ACTION_CHARS),
    risk: input.risk,
    outcome: input.outcome,
    error_code: input.errorCode ?? null,
    parameter_digest: parameterDigest(input.parameters),
    parameter_keys: parameterKeys(input.parameters),
    idempotency_key: findIdempotencyKey(input.parameters),
    supplier_id: input.supplierId,
  };
}

export interface AuditAppendResult {
  ok: boolean;
  error?: string;
}

/** Append-only JSONL sink. A disabled sink (audit off) is `null`, not an object. */
export interface AuditSink {
  append(record: AuditRecord): AuditAppendResult;
  /** Cheap writability check used to fail-close write lanes before they execute. */
  probe(): AuditAppendResult;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAuditSink(filePath: string): AuditSink {
  const directory = path.dirname(filePath);
  const ensureParent = (): void => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(directory, 0o700); } catch { /* best effort (Windows) */ }
  };
  const open = (): void => {
    // Flag 'a' is append-only: writes can never truncate or rewrite earlier lines.
    // Mode 0600 applies when the file is first created.
    const fd = fs.openSync(filePath, 'a', 0o600);
    fs.closeSync(fd);
  };
  return {
    probe(): AuditAppendResult {
      try {
        ensureParent();
        open();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    },
    append(record: AuditRecord): AuditAppendResult {
      try {
        ensureParent();
        fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'a' });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    },
  };
}
