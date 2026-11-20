/** SHEIN signature, grant decryption, and the tempToken authorization flow.
 *  Ported from the Orkas `shein-seller-api.cjs` adapter; logic is unchanged. */
import * as crypto from 'node:crypto';
import { request } from './client.js';
import { saveCredentials } from './config.js';
import { identity, execute } from './actions/registry.js';
import { fail, type AppCredentials, type Credentials } from './types.js';

const hash = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

const secret = (text: string | undefined, min = 8): text is string =>
  typeof text === 'string' && text.length >= min && text.length <= 4096
  && !/[\s\u0000-\u001f\u007f]/.test(text);

export const API_BASE = 'https://openapi.sheincorp.com';

/** HMAC-SHA256 request signature per SHEIN Open Platform spec. */
export function signature(openKeyId: string, secretKey: string, timestamp: string, path: string,
  random = crypto.randomBytes(4).toString('hex').slice(0, 5)): string {
  const hex = crypto.createHmac('sha256', secretKey + random)
    .update(`${openKeyId}&${timestamp}&${path}`).digest('hex');
  return random + Buffer.from(hex, 'utf8').toString('base64');
}

/** Decrypt the AES-128-CBC encrypted secret_key returned by the grant exchange. */
export function decryptSecret(ciphertext: string, appSecret: string): string {
  if (typeof ciphertext !== 'string' || ciphertext.length > 8192
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) {
    fail('invalid_response', 'Invalid encrypted SHEIN grant');
  }
  try {
    const key = Buffer.alloc(16);
    Buffer.from(appSecret, 'utf8').copy(key, 0, 0, 16);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key,
      Buffer.from('space-station-default-iv', 'utf8').subarray(0, 16));
    const value = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()])
      .toString('utf8');
    if (!secret(value)) throw new Error('invalid');
    return value;
  } catch {
    fail('invalid_response', 'SHEIN grant could not be decrypted with this app secret');
  }
}

/** Seller authorization entry point. redirectUri must be registered on the SHEIN app. */
export function authorizeUrl(app: AppCredentials, redirectUri: string, state: string): string {
  if (!secret(app.app_id, 3) || !secret(app.app_secret)) {
    fail('invalid_credentials', 'Invalid SHEIN app credentials');
  }
  const query = new URLSearchParams({
    appid: app.app_id,
    redirectUrl: Buffer.from(redirectUri, 'utf8').toString('base64'),
    state,
  });
  return `https://openapi-sem.sheincorp.com/#/empower?${query}`;
}

/** Exchange a tempToken for the long-lived seller grant, verify it, and persist it.
 *  Verification mirrors the Orkas adapter: identity, one product page, one 48h order window,
 *  and the warehouse list must all succeed before the grant is accepted. */
export async function authorizeFromTempToken(app: AppCredentials, tempToken: string): Promise<Credentials> {
  if (!secret(app.app_id, 3) || !secret(app.app_secret)) {
    fail('invalid_credentials', 'Invalid SHEIN app credentials');
  }
  if (typeof tempToken !== 'string' || !tempToken || tempToken.length > 4096) {
    fail('invalid_credentials', 'Missing SHEIN temporary authorization token');
  }
  const authRequest = async (path: string, body: unknown) =>
    request(app, path, body, { auth: true });

  const data = await authRequest('/open-api/auth/get-by-token', { tempToken }) as Record<string, any>;
  if (data.appid !== app.app_id || !secret(data.openKeyId)
    || (!Number.isSafeInteger(data.supplierId) && typeof data.supplierId !== 'string')
    || !/^[1-9][0-9]*$/.test(String(data.supplierId))) {
    fail('binding_mismatch', 'SHEIN authorization does not identify this app and seller');
  }
  const credentials: Credentials = {
    app_id: app.app_id,
    app_secret: app.app_secret,
    open_key_id: data.openKeyId,
    secret_key: decryptSecret(data.secretKey, app.app_secret),
    identity: {
      supplier_id: String(data.supplierId),
      app_fingerprint: hash(app.app_id),
      grant_fingerprint: hash(data.openKeyId),
    },
  };
  await identity(credentials);
  await execute(credentials, 'products.list', { limit: 1 });
  const now = Math.floor(Date.now() / 1000);
  await execute(credentials, 'orders.list', { limit: 1, start_time: now - 86400, end_time: now });
  await execute(credentials, 'warehouses.list', {});
  saveCredentials(credentials);
  return credentials;
}
