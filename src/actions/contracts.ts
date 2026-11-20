/** Pinned native contract loader. The JSON is generated offline from SHEIN's official
 *  seller documentation (snapshot 2026-09-30) — never from a live provider response.
 *  Every method carries an explicit risk entry; nothing discovers or widens scope at runtime. */
import { createRequire } from 'node:module';
import type { ActionSpec, ContractMethod, ContractsDocument } from '../types.js';

const require_ = createRequire(import.meta.url);

let document_: ContractsDocument | null = null;
let nativeActions: Record<string, ActionSpec> | null = null;

function doc(): ContractsDocument {
  if (!document_) {
    // src/actions/ and dist/actions/ share the same depth, so this resolves to the
    // repo-root contracts/ directory in both the source tree and the build output.
    document_ = require_('../../contracts/shein-api-contracts.json') as unknown as ContractsDocument;
  }
  return document_;
}

export function nativeMethods(): Record<string, ContractMethod> {
  return doc().methods;
}

export function nativeActionsFor(): Record<string, ActionSpec> {
  nativeActions ||= Object.fromEntries(
    Object.entries(doc().methods).map(([name, method]) => [name, {
      risk: method.risk,
      description: method.description,
      input_schema: method.input_schema,
    }]),
  );
  return nativeActions;
}

export interface Coverage {
  complete: false;
  documentation_snapshot: string;
  scope: string;
  reviewed_business_methods: number;
  host_owned_methods: Record<string, string>;
  other_application_methods: string[];
  max_inline_parameter_bytes: number;
}

export function coverageFor(): Coverage {
  const source = doc();
  return {
    complete: false,
    documentation_snapshot: source.documentation_snapshot,
    scope: source.scope,
    reviewed_business_methods: Object.keys(source.methods).length,
    host_owned_methods: { ...source.host_owned_methods },
    other_application_methods: [...source.other_application_methods],
    max_inline_parameter_bytes: 256 * 1024,
  };
}
