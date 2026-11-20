/** Shared types for the SHEIN MCP server. */

/** Long-lived seller grant produced by authorization. `app_fingerprint`/`grant_fingerprint`
 *  pin the credentials to the app + grant they were issued for; a mismatch is a hard error. */
export interface Credentials {
  app_id: string;
  app_secret: string;
  open_key_id: string;
  secret_key: string;
  identity: {
    supplier_id: string;
    app_fingerprint: string;
    grant_fingerprint: string;
  };
}

/** App-only credentials used while exchanging a tempToken for the seller grant. */
export interface AppCredentials {
  app_id: string;
  app_secret: string;
}

/** One executable action. Mirrors the Orkas connector action shape. */
export interface ActionSpec {
  risk: 'R' | 'W' | 'H' | 'D';
  description: string;
  input_schema: Record<string, unknown>;
}

/** One pinned native (documentation-derived) contract method. */
export interface ContractMethod {
  id: number;
  method: string;
  path: string;
  risk: 'R' | 'W' | 'H' | 'D';
  description: string;
  input_schema: Record<string, unknown>;
  response_field?: string;
  result_type?: 'array' | 'object' | 'string' | 'boolean';
  allow_absent_result?: boolean;
  multipart?: boolean;
}

export interface ContractsDocument {
  documentation_snapshot: string;
  scope: string;
  methods: Record<string, ContractMethod>;
  host_owned_methods: Record<string, string>;
  other_application_methods: string[];
}

/** Structured adapter error. `kind` maps to a stable failure category. */
export class SheinError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

export function fail(kind: string, message: string): never {
  throw new SheinError(kind, message);
}
