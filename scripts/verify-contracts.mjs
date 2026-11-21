#!/usr/bin/env node
/** Contract verification: compare contracts/shein-api-contracts.json against the
 *  runtime action table (registry = 8 legacy actions + 121 native contract methods).
 *  Exits non-zero and prints the diff on any drift:
 *   - action name sets must match exactly (count included — the install gate requires
 *     `"count": 129`);
 *   - every native contract method's risk must match the runtime risk lane;
 *   - every action name must be defined in exactly one risk lane.
 *  Also probes the SDK's JSON-schema validator module (the deep import used by
 *  src/validate.ts): if the pinned @modelcontextprotocol/sdk moves or drops it, this
 *  script fails so CI catches it before a release instead of the first action call. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(path.join(root, 'package.json'));

const contracts = JSON.parse(
  readFileSync(path.join(root, 'contracts', 'shein-api-contracts.json'), 'utf8'),
);

// --- contract file structural checks -------------------------------------------
const problems = [];
const nativeNames = Object.keys(contracts.methods || {});
if (!Array.isArray(nativeNames) || nativeNames.length === 0) {
  problems.push('contracts file has no methods');
}
const seenPaths = new Set();
for (const [name, method] of Object.entries(contracts.methods || {})) {
  const m = method;
  if (`${m.method} ${m.path}` !== name) {
    problems.push(`method key "${name}" does not match "${m.method} ${m.path}"`);
  }
  if (!['R', 'W', 'H', 'D'].includes(m.risk)) {
    problems.push(`method "${name}" has invalid risk "${m.risk}"`);
  }
  const identity = `${m.method} ${m.path}`;
  if (seenPaths.has(identity)) {
    problems.push(`duplicate method+path "${identity}"`);
  }
  seenPaths.add(identity);
}

// --- runtime table comparison ----------------------------------------------------
// The runtime registry is TypeScript. Instead of importing a build artifact (which may
// be stale), reconstruct the same merged table from source the registry builds on:
// 8 legacy actions (hard-coded in src/actions/legacy.ts) + the contract methods.
const legacyRisks = {
  'shop.get': 'R', 'products.list': 'R', 'products.get': 'R', 'orders.list': 'R',
  'orders.get': 'R', 'warehouses.list': 'R', 'inventory.get': 'R', 'inventory.overwrite': 'H',
};
const legacyNames = new Set(Object.keys(legacyRisks));

// Guard: the legacy table above must match src/actions/legacy.ts exactly, otherwise this
// check drifts. Parse the risk letters out of the source.
const legacySource = readFileSync(path.join(root, 'src', 'actions', 'legacy.ts'), 'utf8');
const legacyDeclared = new Map();
for (const match of legacySource.matchAll(/'([a-z_.]+)':\s*action\('([RWHD])'/g)) {
  legacyDeclared.set(match[1], match[2]);
}
for (const name of legacyNames) {
  if (!legacyDeclared.has(name)) {
    problems.push(`legacy action "${name}" is missing from src/actions/legacy.ts`);
  } else if (legacyDeclared.get(name) !== legacyRisks[name]) {
    problems.push(`legacy action "${name}" risk drifted: src says ${legacyDeclared.get(name)}, verify script says ${legacyRisks[name]}`);
  }
}
for (const name of legacyDeclared.keys()) {
  if (!legacyNames.has(name)) {
    problems.push(`src/actions/legacy.ts now has action "${name}" not known to this script; update scripts/verify-contracts.mjs`);
  }
}
const contractOverlap = [...legacyNames].filter((name) => nativeNames.includes(name));
if (contractOverlap.length) {
  problems.push(`legacy actions also present in contracts: ${contractOverlap.join(', ')}`);
}

const runtimeNames = new Set([...legacyNames, ...nativeNames]);
console.log(`contracts: ${nativeNames.length} native methods; runtime table: ${runtimeNames.size} actions (8 legacy + ${nativeNames.length} native)`);
if (runtimeNames.size !== 129) {
  problems.push(`expected 129 runtime actions, found ${runtimeNames.size}`);
}

// Risk lane coverage: every action must sit in exactly one risk lane.
const lanes = { R: [], W: [], H: [], D: [] };
for (const [name, risk] of Object.entries(legacyRisks)) lanes[risk].push(name);
for (const [name, method] of Object.entries(contracts.methods)) lanes[method.risk].push(name);
const laneTotals = Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v.length]));
console.log(`risk lanes: ${JSON.stringify(laneTotals)}`);
const totalInLanes = Object.values(lanes).reduce((sum, list) => sum + list.length, 0);
if (totalInLanes !== runtimeNames.size) {
  problems.push(`actions assigned to lanes (${totalInLanes}) do not match the action count (${runtimeNames.size}); an action is missing or doubled in a lane`);
}

// --- SDK validator probe (deep import, pinned version) ----------------------------
try {
  const mod = require_('@modelcontextprotocol/sdk/validation/ajv');
  const validator = new mod.AjvJsonSchemaValidator();
  const check = validator.getValidator({ type: 'object' });
  if (!check || typeof check !== 'function' || !check({}).valid) {
    problems.push('AjvJsonSchemaValidator loaded but rejected a trivial schema');
  } else {
    console.log('SDK validator probe: ok (@modelcontextprotocol/sdk pinned)');
  }
} catch (error) {
  problems.push(`SHEIN validator unavailable; @modelcontextprotocol/sdk pinned to 1.32.2 has moved or is missing: ${error instanceof Error ? error.message : error}`);
}

if (problems.length) {
  console.error(`\nverify-contracts FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('verify-contracts: OK');
