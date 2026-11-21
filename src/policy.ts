/** Operating-lane policy per ADR-0008: this server is an operations tool, not a data
 *  pipeline. The default is read-only. Write / high-impact / destructive lanes and the
 *  audit log are explicit operator switches with fail-closed combinations:
 *    - `SHEIN_MCP_AUDIT_LOG=off` is only valid for a read-only lane set;
 *    - prod (`SHEIN_MCP_ENV=prod`) requires the audit log and refuses a half-armed
 *      destructive lane;
 *    - `execute_destructive` needs two switches: the `destructive` lane AND
 *      `SHEIN_MCP_ALLOW_DESTRUCTIVE=1`.
 *  Pure parsing/validation — no filesystem access here. */
import * as path from 'node:path';
import * as os from 'node:os';
import { fail } from './types.js';

export const LANES = ['read', 'write', 'high_impact', 'destructive'] as const;
export type Lane = (typeof LANES)[number];
export type Risk = 'R' | 'W' | 'H' | 'D';

export type ToolName =
  | 'list_capabilities'
  | 'describe_action'
  | 'execute_read'
  | 'execute_write'
  | 'execute_high_impact'
  | 'execute_destructive';

const TOOL_LANE: Record<ToolName, Lane> = {
  list_capabilities: 'read',
  describe_action: 'read',
  execute_read: 'read',
  execute_write: 'write',
  execute_high_impact: 'high_impact',
  execute_destructive: 'destructive',
};

const RISK_LANE: Record<Risk, Lane> = { R: 'read', W: 'write', H: 'high_impact', D: 'destructive' };

export interface Policy {
  readonly lanes: readonly Lane[];
  readonly allowDestructive: boolean;
  readonly env: 'test' | 'prod';
  readonly auditOff: boolean;
  readonly auditPath: string;
}

export function defaultAuditPath(): string {
  return path.join(os.homedir(), '.shein-mcp', 'audit.jsonl');
}

function parseLanes(raw: string | undefined): Lane[] {
  const lanes = new Set<Lane>(['read']); // the read lane is always on
  if (raw === undefined || raw.trim() === '') return [...lanes];
  for (const token of raw.split(',')) {
    const candidate = token.trim().toLowerCase();
    if (!(LANES as readonly string[]).includes(candidate)) {
      fail('policy_invalid',
        `SHEIN_MCP_LANES contains an unknown lane "${token.trim()}"; allowed lanes: ${LANES.join(', ')}`);
    }
    lanes.add(candidate as Lane);
  }
  return [...lanes].sort((a, b) => LANES.indexOf(a) - LANES.indexOf(b));
}

export function parsePolicy(source: NodeJS.ProcessEnv = process.env): Policy {
  const lanes = parseLanes(source.SHEIN_MCP_LANES);
  const destructiveSwitch = source.SHEIN_MCP_ALLOW_DESTRUCTIVE;
  if (destructiveSwitch !== undefined && destructiveSwitch !== '' && destructiveSwitch !== '1') {
    fail('policy_invalid', 'SHEIN_MCP_ALLOW_DESTRUCTIVE must be exactly "1" to arm the destructive lane');
  }
  const allowDestructive = destructiveSwitch === '1';
  const env = source.SHEIN_MCP_ENV ?? 'test';
  if (env !== 'test' && env !== 'prod') {
    fail('policy_invalid', 'SHEIN_MCP_ENV must be "test" or "prod"');
  }
  const auditSetting = (source.SHEIN_MCP_AUDIT_LOG ?? '').trim();
  const auditOff = auditSetting.toLowerCase() === 'off';
  const auditPath = auditSetting === '' ? defaultAuditPath() : auditSetting;
  const writeLanes = lanes.some((lane) => lane !== 'read');
  if (auditOff && writeLanes) {
    fail('policy_invalid',
      'SHEIN_MCP_AUDIT_LOG=off is only allowed for a read-only lane set; the audit log is '
      + 'mandatory for the write, high_impact and destructive lanes. Point '
      + 'SHEIN_MCP_AUDIT_LOG at a writable file, or restrict SHEIN_MCP_LANES to read.');
  }
  if (env === 'prod') {
    if (auditOff) {
      fail('policy_invalid',
        'SHEIN_MCP_ENV=prod requires the audit log; SHEIN_MCP_AUDIT_LOG=off is not allowed in prod');
    }
    if (lanes.includes('destructive') && !allowDestructive) {
      fail('policy_invalid',
        'SHEIN_MCP_ENV=prod refuses a half-armed destructive lane: remove "destructive" from '
        + 'SHEIN_MCP_LANES, or also set SHEIN_MCP_ALLOW_DESTRUCTIVE=1');
    }
  }
  return { lanes, allowDestructive, env, auditOff, auditPath };
}

export function toolEnabled(tool: ToolName, policy: Policy): boolean {
  if (!policy.lanes.includes(TOOL_LANE[tool])) return false;
  return tool !== 'execute_destructive' || policy.allowDestructive;
}

export function actionAvailable(risk: Risk, policy: Policy): boolean {
  if (!policy.lanes.includes(RISK_LANE[risk])) return false;
  return risk !== 'D' || policy.allowDestructive;
}

export function disabledToolMessage(tool: ToolName, policy: Policy): string {
  const enabled = policy.lanes.join(', ');
  if (tool === 'execute_destructive') {
    return `Tool execute_destructive is disabled by the current lane configuration `
      + `(enabled lanes: ${enabled}). It requires two switches: SHEIN_MCP_LANES must include `
      + `"destructive" and SHEIN_MCP_ALLOW_DESTRUCTIVE must be "1".`;
  }
  const lane = TOOL_LANE[tool];
  return `Tool ${tool} is disabled by the current lane configuration `
    + `(enabled lanes: ${enabled}). Add "${lane}" to SHEIN_MCP_LANES to enable it.`;
}
