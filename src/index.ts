#!/usr/bin/env node
/** CLI entry points:
 *   shein-mcp serve                        (default) run the stdio MCP server
 *   shein-mcp authorize --temp-token X     exchange a tempToken for the seller grant
 *       [--app-id ID --app-secret S]       (defaults from env or existing config)
 *       [--redirect-uri URL]               print the authorization URL instead, when no token
 *   shein-mcp whoami                       verify the binding and print seller identity
 *   shein-mcp list-actions                 print the reviewed action table (no network)
 */
import { authorizeFromTempToken, authorizeUrl, API_BASE } from './auth.js';
import { appCredentialsFromEnv, loadCredentials, readConfigFile, saveCredentials } from './config.js';
import { identity, actionsFor } from './actions/registry.js';
import { SheinError } from './types.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2] || 'serve';

  if (command === 'serve') {
    const { serve } = await import('./server.js');
    await serve();
    return;
  }

  if (command === 'authorize') {
    const appId = arg('app-id') ?? appCredentialsFromEnv()?.app_id ?? readConfigFile()?.app_id;
    const appSecret = arg('app-secret') ?? appCredentialsFromEnv()?.app_secret ?? readConfigFile()?.app_secret;
    if (!appId || !appSecret) {
      console.error('Missing app credentials. Pass --app-id/--app-secret or set SHEIN_APP_ID/SHEIN_APP_SECRET.');
      process.exit(2);
    }
    const app = { app_id: appId, app_secret: appSecret };
    const redirectUri = arg('redirect-uri') ?? 'https://example.com/shein/callback';
    const tempToken = arg('temp-token');
    if (!tempToken) {
      console.log('1. Register this redirect URI on your SHEIN app:');
      console.log(`   ${redirectUri}`);
      console.log('2. Open the authorization URL and approve with the shop main account:');
      console.log(`   ${authorizeUrl(app, redirectUri, 'shein-mcp')}`);
      console.log('3. Your callback receives tempToken; then run:');
      console.log('   shein-mcp authorize --temp-token <TOKEN>');
      return;
    }
    try {
      const credentials = await authorizeFromTempToken(app, tempToken);
      console.log(`Authorized supplier ${credentials.identity.supplier_id}; grant saved to ~/.shein-mcp/credentials.json`);
    } catch (error) {
      console.error(`Authorization failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'whoami') {
    try {
      const credentials = loadCredentials();
      const who = await identity(credentials);
      console.log(JSON.stringify(who, null, 2));
    } catch (error) {
      console.error(`Identity check failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'list-actions') {
    const actions = actionsFor();
    const rows = Object.entries(actions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, spec]) => ({ action: name, risk: spec.risk, description: spec.description }));
    console.log(JSON.stringify({ api_base: API_BASE, count: rows.length, actions: rows }, null, 2));
    return;
  }

  console.error(`Unknown command: ${command}. Use serve | authorize | whoami | list-actions.`);
  process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof SheinError ? `[${error.kind}] ${error.message}` : error);
  process.exit(1);
});
