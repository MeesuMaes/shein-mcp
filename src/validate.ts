/** Parameter validation. Native contract methods validate through Ajv (the MCP SDK's
 *  JSON-schema validator); the eight legacy actions use a minimal structural check. */
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

type AjvCheck = (value: unknown) => { valid: boolean };
type AjvFactory = { getValidator(schema: Record<string, unknown>): AjvCheck };

const validators = new Map<string, AjvCheck>();
let ajvFactory: AjvFactory | null = null;

/** Ajv-backed validation for native actions (full JSON Schema semantics). */
export function validateNative(parameters: unknown, name: string,
  inputSchema: Record<string, unknown>): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(parameters);
  } catch {
    failInvalid(name);
  }
  if (!serialized || Buffer.byteLength(serialized) > 256 * 1024) failInvalid(name);
  if (!ajvFactory) {
    const mod = require_('@modelcontextprotocol/sdk/validation/ajv.js') as
      { AjvJsonSchemaValidator: new () => AjvFactory };
    ajvFactory = new mod.AjvJsonSchemaValidator();
  }
  let check = validators.get(name);
  if (!check) {
    check = ajvFactory.getValidator(inputSchema);
    validators.set(name, check);
  }
  if (!check(parameters).valid) failInvalid(name);
}

function failInvalid(name: string): never {
  throw Object.assign(
    new Error(`Invalid SHEIN action parameters for ${name}; check the described field types and required fields`),
    { code: 'validation_failed' },
  );
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Minimal recursive schema check for the legacy actions (subset: object/array/integer/string). */
export function validateLegacy(value: unknown, schema: Record<string, any>): void {
  if (schema.type === 'object') {
    if (!isObject(value)
      || Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))
      || schema.required.some((key: string) => !Object.hasOwn(value, key))) {
      throw new Error('Invalid SHEIN action parameters');
    }
    for (const [key, child] of Object.entries(value)) validateLegacy(child, schema.properties[key]);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) {
      throw new Error('Invalid SHEIN ID batch');
    }
    value.forEach((child) => validateLegacy(child, schema.items));
  } else if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) {
      throw new Error('Invalid SHEIN numeric parameter');
    }
  } else {
    if (typeof value !== 'string') throw new Error('Invalid SHEIN string parameter');
    if (value.length < (schema.minLength || 0) || value.length > schema.maxLength
      || /[\u0000-\u001f\u007f]/.test(value)
      || (schema.pattern && !new RegExp(schema.pattern).test(value))) {
      throw new Error('Invalid SHEIN string parameter');
    }
  }
}
