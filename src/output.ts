/** Output sanitization. Provider error text is untrusted and may echo credentials;
 *  credential values are replaced before anything reaches the model context. */

const PRIVATE_FIELDS = new Set([
  'accesstoken', 'refreshtoken', 'idtoken', 'appsecret', 'secretkey', 'openkeyid', 'clientsecret',
  'authorization', 'password', 'cookie', 'signature', 'errormsg', 'errormessage',
  'errorordergoodsexpressremark', 'failmsg', 'failreason', 'failedreason', 'failurereason',
  'msg', 'message',
]);

const CREDENTIAL_KEYS = ['app_id', 'app_secret', 'open_key_id', 'secret_key'] as const;

export interface RedactableCredentials {
  app_id?: string;
  app_secret?: string;
  open_key_id?: string;
  secret_key?: string;
}

export function businessOutput(value: unknown, credentials: RedactableCredentials,
  eligibilityReason = false): unknown {
  if (typeof value === 'string') {
    return CREDENTIAL_KEYS.reduce(
      (text, key) => (credentials[key] ? text.split(credentials[key]).join('[redacted]') : text),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => businessOutput(item, credentials, eligibilityReason));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => {
        const canonical = key.replace(/[_-]/g, '').toLowerCase();
        return !PRIVATE_FIELDS.has(canonical)
          && (canonical !== 'reason' || eligibilityReason || typeof item === 'number');
      })
      .map(([key, item]) => [key, businessOutput(item, credentials, eligibilityReason)]),
  );
}

/** Legacy actions sanitize through storefront-style token redaction for every credential value. */
export function redactAll(value: unknown, credentials: RedactableCredentials): unknown {
  let out = value;
  for (const key of CREDENTIAL_KEYS) {
    const secretValue = credentials[key];
    if (!secretValue) continue;
    out = redactValue(out, secretValue);
  }
  return out;
}

function redactValue(value: unknown, token: string): unknown {
  if (typeof value === 'string') return value.split(token).join('[redacted]');
  if (Array.isArray(value)) return value.map((item) => redactValue(item, token));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(?:token|secret|authorization|password|cookie|email|phone|address|customer|buyer|first_name|last_name|ip_address|payment_details|payment_source|credit_card|staff_notes|customer_message|note_attributes)/i.test(key))
      .map(([key, child]) => [key, redactValue(child, token)]),
  );
}
