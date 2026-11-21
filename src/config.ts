/** Credential loading and binding validation.
 *
 * Two sources, env wins:
 *   1. `~/.shein-mcp/credentials.json` (written by `shein-mcp authorize`, mode 0600)
 *   2. Environment variables (SHEIN_APP_ID, SHEIN_APP_SECRET, SHEIN_OPEN_KEY_ID,
 *      SHEIN_SECRET_KEY, SHEIN_SUPPLIER_ID, plus the two fingerprints when reconnecting)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { fail, type AppCredentials, type Credentials } from './types.js';

export const CONFIG_DIR = path.join(os.homedir(), '.shein-mcp');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'credentials.json');

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

const secret = (text: string | undefined, min = 8): text is string =>
  typeof text === 'string' && text.length >= min && text.length <= 4096
  && !/[\s\u0000-\u001f\u007f]/.test(text);

export function appCredentialsFromEnv(): AppCredentials | null {
  const { SHEIN_APP_ID, SHEIN_APP_SECRET } = process.env;
  if (!secret(SHEIN_APP_ID, 3) || !secret(SHEIN_APP_SECRET)) return null;
  return { app_id: SHEIN_APP_ID, app_secret: SHEIN_APP_SECRET };
}

export function credentialsFromEnv(): Credentials | null {
  const env = process.env;
  const openKeyId = env.SHEIN_OPEN_KEY_ID;
  const secretKey = env.SHEIN_SECRET_KEY;
  const supplierId = env.SHEIN_SUPPLIER_ID;
  if (!secret(openKeyId) || !secret(secretKey) || !/^[1-9][0-9]*$/.test(supplierId || '')) return null;
  const app = appCredentialsFromEnv();
  if (!app) return null;
  return {
    app_id: app.app_id,
    app_secret: app.app_secret,
    open_key_id: openKeyId,
    secret_key: secretKey,
    identity: {
      supplier_id: supplierId as string,
      app_fingerprint: hash(app.app_id),
      grant_fingerprint: hash(openKeyId),
    },
  };
}

const isPosix = process.platform !== 'win32';

/** POSIX-only credential file permission check (ADR-0008): the file must be 0600.
 *  Windows ACLs don't map to a POSIX mode, so no check is performed there rather
 *  than reporting a meaningless mode. */
function checkCredentialFileMode(filePath: string): void {
  if (!isPosix) return;
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if (mode !== 0o600) {
      fail('permission_denied',
        `Credential file ${filePath} must have mode 0600 (found ${mode.toString(8)}); run: chmod 600 ${filePath}`);
    }
  } catch (error) {
    if ((error as { code?: string })?.code === 'ENOENT') return;
    if (error && typeof error === 'object' && 'kind' in error) throw error;
    fail('permission_denied', `Credential file ${filePath} is not readable or its mode cannot be verified`);
  }
}

export function readConfigFile(): Credentials | null {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Credentials;
    if (!secret(parsed.app_id, 3) || !secret(parsed.app_secret)
      || !secret(parsed.open_key_id) || !secret(parsed.secret_key)
      || !/^[1-9][0-9]*$/.test(parsed.identity?.supplier_id || '')) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** File-sourced credentials must pass the 0600 check (env-sourced ones have no file). */
export function loadFileCredentials(): Credentials | null {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  checkCredentialFileMode(CONFIG_FILE);
  return readConfigFile();
}

/** Env wins over the config file so CI/sandbox runs can override without editing state. */
export function loadCredentials(): Credentials {
  const fromEnv = credentialsFromEnv();
  if (fromEnv) return fromEnv;
  const fromFile = loadFileCredentials();
  if (fromFile) return fromFile;
  fail('credentials_missing',
    'No SHEIN credentials found. Run `shein-mcp authorize` or set SHEIN_* environment variables.');
}

/** Validate the full seller binding. Fingerprints must match the current secrets. */
export function validateBinding(credentials: Credentials): void {
  const c = credentials;
  if (!secret(c.open_key_id) || !secret(c.secret_key)
    || !/^[1-9][0-9]*$/.test(c.identity?.supplier_id || '')
    || c.identity?.app_fingerprint !== hash(c.app_id)
    || c.identity?.grant_fingerprint !== hash(c.open_key_id)) {
    fail('binding_mismatch', 'SHEIN app or seller grant changed; run `shein-mcp authorize` again');
  }
}

/** Persist the grant produced by `authorize`. Mode 0600; refuses to widen an existing file. */
export function saveCredentials(credentials: Credentials): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort (Windows) */ }
  const file = CONFIG_FILE;
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}
