/** Signed request core. Ported from the Orkas `shein-seller-api.cjs` `request()`.
 *  Handles app-level (auth) and seller-level (grant) signing, error mapping,
 *  envelope validation, and contract result-shape checks. */
import { signature } from './auth.js';
import { validateBinding } from './config.js';
import { fail, type AppCredentials, type ContractMethod, type Credentials } from './types.js';

const API_BASE = 'https://openapi.sheincorp.com';

/** Cancelled / timed-out / network failure classification at the IO boundary. */
function requestFailureCode(error: unknown, deadline: AbortSignal): string {
  if (deadline.aborted || (error as { name?: string })?.name === 'TimeoutError') return 'E_TOOL_CALL_TIMEOUT';
  if ((error as { name?: string })?.name === 'AbortError') return 'E_TOOL_CALL_CANCELLED';
  return 'E_TOOL_CALL_NETWORK';
}

/** Read the response body with a size cap so a provider-controlled 200 cannot stream into memory. */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw Object.assign(new Error('Response too large'), { code: 'E_RESPONSE_TOO_LARGE' });
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw Object.assign(new Error('Response too large'), { code: 'E_RESPONSE_TOO_LARGE' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface RequestOptions {
  /** Sign with app credentials (authorization flow) instead of the seller grant. */
  auth?: boolean;
  /** Contract for native contract methods; supplies method/path/result shape. */
  contract?: ContractMethod;
  /** Legacy write: shapes the failure message but skips contract result checks. */
  write?: boolean;
  query?: Record<string, unknown>;
}

export async function request(
  credentials: Credentials | AppCredentials,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<unknown> {
  const full = credentials as Credentials;
  const isGrant = !options.auth;
  if (isGrant) validateBinding(full);
  const c = credentials;
  const timestamp = String(Date.now());
  const key = isGrant ? (c as Credentials).open_key_id : (c as AppCredentials).app_id;
  const secretKey = isGrant ? (c as Credentials).secret_key : (c as AppCredentials).app_secret;
  const url = new URL(API_BASE + path);
  for (const [name, value] of Object.entries(options.query || {})) url.searchParams.set(name, String(value));
  const contract = options.contract;
  const multipart = contract?.multipart === true;
  const deadline = AbortSignal.timeout(multipart ? 600_000 : 60_000);
  const ioFailure = (error: unknown): never => {
    const code = requestFailureCode(error, deadline);
    const write = options.write || (contract !== undefined && contract.risk !== 'R');
    const message = `SHEIN request failed${write
      ? '; inspect the affected resource before retrying an uncertain write' : ''}`;
    if (code === 'E_TOOL_CALL_CANCELLED') throw Object.assign(new Error(message), { code });
    return fail(code === 'E_TOOL_CALL_TIMEOUT' ? 'timeout' : 'network_failed', message);
  };

  const send = async (): Promise<Response> => {
    try {
      return await fetch(url.toString(), {
        method: contract?.method || (body === undefined ? 'GET' : 'POST'),
        headers: {
          accept: 'application/json',
          ...(!multipart ? { 'content-type': 'application/json;charset=UTF-8' } : {}),
          language: 'en',
          'x-lt-language': 'US',
          [isGrant ? 'x-lt-openKeyId' : 'x-lt-appid']: key,
          'x-lt-timestamp': timestamp,
          'x-lt-signature': signature(key, secretKey, timestamp, path),
        },
        ...(body !== undefined ? { body: multipart ? (body as FormData) : JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: deadline,
      });
    } catch (error) {
      throw ioFailure(error);
    }
  };
  const response = await send();
  if (!response.ok) {
    fail([401, 403].includes(response.status) ? 'permission_denied'
      : response.status === 429 ? 'rate_limit'
      : 'upstream_error', `SHEIN API failed (HTTP ${response.status})`);
  }
  const read = async (): Promise<string> => {
    try {
      return await readBody(response, 32 * 1024 * 1024);
    } catch (error) {
      if ((error as { code?: string })?.code === 'E_RESPONSE_TOO_LARGE') {
        fail('upstream_error', 'SHEIN returned invalid or oversized JSON');
      }
      throw ioFailure(error);
    }
  };
  const text = await read();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    fail('upstream_error', 'SHEIN returned invalid or oversized JSON');
  }
  if (String((data as { code?: unknown })?.code) !== '0') {
    fail('request_failed', 'SHEIN rejected the request; verify seller authorization, app business mode and API permissions');
  }
  const result = (data as Record<string, unknown>)?.[contract?.response_field || 'info'];
  if (contract) {
    if (contract.allow_absent_result && result == null) return null;
    const valid = contract.result_type === 'array' ? Array.isArray(result)
      : contract.result_type === 'object' ? result !== null && typeof result === 'object' && !Array.isArray(result)
      : contract.result_type === 'string' ? typeof result === 'string'
      : contract.result_type === 'boolean' ? typeof result === 'boolean' : false;
    if (!valid) fail('invalid_response', 'SHEIN returned an invalid business acknowledgement');
  } else if (result === undefined || result === null) {
    fail('request_failed', 'SHEIN rejected the request; verify seller authorization, app business mode and API permissions');
  }
  return result;
}
