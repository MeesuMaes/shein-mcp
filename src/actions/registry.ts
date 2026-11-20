/** Action registry: merges the eight legacy actions with the pinned native contracts,
 *  and routes execution. Action names are stable identifiers; native names are the
 *  documented `"<METHOD> <path>"` strings, matching the Orkas connector surface. */
import { executeLegacy, identity, legacyActionsFor } from './legacy.js';
import { executeNative, methodFor } from './native.js';
import { coverageFor, nativeActionsFor, type Coverage } from './contracts.js';
import { fail, type ActionSpec, type Credentials } from '../types.js';

export function actionsFor(): Record<string, ActionSpec> {
  return { ...legacyActionsFor(), ...nativeActionsFor() };
}

export { coverageFor };
export type { Coverage };

/** Risk-to-umbrella mapping used by the six MCP tools. */
export function toolForRisk(risk: ActionSpec['risk']): string {
  switch (risk) {
    case 'R': return 'execute_read';
    case 'W': return 'execute_write';
    case 'H': return 'execute_high_impact';
    case 'D': return 'execute_destructive';
    default: return 'execute_read';
  }
}

export async function execute(credentials: Credentials, name: string,
  parameters: Record<string, unknown> = {}): Promise<unknown> {
  const legacy = Object.hasOwn(legacyActionsFor(), name);
  const spec = actionsFor()[name];
  if (!spec) fail('validation_failed', `Unreviewed SHEIN action: ${name}`);
  if (legacy) return executeLegacy(credentials, name, parameters);
  const contract = methodFor(name);
  if (!contract) fail('validation_failed', `Unreviewed SHEIN action: ${name}`);
  return executeNative(credentials, name, parameters, contract);
}

export { identity };
