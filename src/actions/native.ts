/** Native (documentation-pinned) contract execution: schema validation, parameter shaping,
 *  partial-failure detection, and sanitized output. Ported from the Orkas adapter's
 *  native branch; acknowledgement semantics are unchanged. */
import { request } from '../client.js';
import { businessOutput } from '../output.js';
import { validateNative } from '../validate.js';
import { nativeMethods } from './contracts.js';
import { fail, type ContractMethod, type Credentials } from '../types.js';

function stockArguments(body: Record<string, unknown>, version: 1 | 2): Array<Record<string, unknown>> {
  const entries = body.updateSkuInventoryQuantityRequests as Array<Record<string, unknown>>;
  if (new Set(entries.map((item) => `${item.skuCode}\0${item.warehouseCode || ''}\0${item.invType || ''}`)).size !== entries.length
    || (version === 2 && new Set(entries.map((item) => item.idempotencyKey)).size !== entries.length)) {
    fail('validation_failed', 'Invalid SHEIN stock action parameters; use distinct items and idempotency keys');
  }
  return entries;
}

/** Interpret provider acknowledgement data for non-read actions. Returns true when the call
 *  partially or fully failed; throws when the acknowledgement itself is unusable. */
function nativeFailure(contract: ContractMethod, data: any, parameters: Record<string, unknown>): boolean {
  const id = contract.id;
  const body = (parameters.body || {}) as Record<string, unknown>;
  if ([3002018, 3002019].includes(id)) {
    if (typeof data?.success !== 'boolean' || (data.success && (typeof data.spu_name !== 'string' || !data.spu_name
      || (body.spu_name && data.spu_name !== body.spu_name)))) {
      fail('invalid_response', 'SHEIN product submission was not fully acknowledged; inspect product audit status before retrying');
    }
    return data.success === false || (Array.isArray(data.filtered_result) && data.filtered_result.length > 0);
  }
  if (id === 3001940) {
    const rows = data?.data;
    const requested = (body.productPriceList || []) as Array<Record<string, unknown>>;
    const keys = new Set(requested.map((item) => `${item.productCode}\0${item.site}`));
    if (!Array.isArray(rows) || rows.length !== requested.length || keys.size !== requested.length
      || new Set(rows.map((item: any) => `${item.productCode}\0${item.site}`)).size !== rows.length
      || rows.some((item: any) => !keys.has(`${item.productCode}\0${item.site}`) || typeof item.success !== 'boolean'
        || (item.status !== undefined && ![0, 1, 2].includes(item.status)))) {
      fail('invalid_response', 'SHEIN price changes were not fully acknowledged; inspect price review results before retrying');
    }
    return rows.some((item: any) => item.success === false || item.status === 0);
  }
  if ([3001692, 3001738].includes(id)) {
    const requested = stockArguments(body, id === 3001738 ? 2 : 1);
    // The v2 table describes a single failed object; the adapter contract and legacy API
    // both use a list. Both shapes are failure records, never prose.
    const rawFailures: unknown = data?.failedList;
    const failures: Array<Record<string, unknown>> | null = Array.isArray(rawFailures)
      ? rawFailures as Array<Record<string, unknown>>
      : rawFailures && typeof rawFailures === 'object' && typeof (rawFailures as Record<string, unknown>).skuCode === 'string'
        ? [rawFailures as Record<string, unknown>] : null;
    const ids = new Set(requested.map((item) => item.skuCode));
    if (!failures || failures.some((item) => !ids.has(item?.skuCode))) {
      fail('invalid_response', 'SHEIN inventory change was not fully acknowledged; inspect stock before retrying');
    }
    const failedRows = failures as Array<Record<string, unknown>>;
    if (id === 3001692) {
      const accepted = data.successList;
      if (!Array.isArray(accepted) || accepted.length + failedRows.length !== requested.length
        || accepted.some((item: any) => !ids.has(item?.skuCode))) {
        fail('invalid_response', 'SHEIN inventory change was not fully acknowledged; inspect stock before retrying');
      }
      const counts = new Map<unknown, number>();
      requested.forEach((item) => counts.set(item.skuCode, (counts.get(item.skuCode) || 0) + 1));
      [...accepted, ...failedRows].forEach((item: any) => counts.set(item.skuCode, (counts.get(item.skuCode) || 0) - 1));
      if ([...counts.values()].some((count) => count !== 0)) {
        fail('invalid_response', 'SHEIN inventory change was not fully acknowledged; inspect stock before retrying');
      }
    }
    return failedRows.length > 0;
  }
  if (id === 3001274) return data.length > 0;
  if (id === 3001283) {
    const requested = new Set(body.goodsIdList as Array<unknown>);
    if (data?.returnOrderNo !== body.returnOrderNo || !Array.isArray(data.goodsIdList)
      || new Set(data.goodsIdList).size !== data.goodsIdList.length
      || data.goodsIdList.some((item: unknown) => !requested.has(item))) {
      fail('invalid_response', 'SHEIN return receipt was not acknowledged; inspect the return order before retrying');
    }
    return data.goodsIdList.length !== requested.size;
  }
  const failureArrays: Record<number, string> = {
    3001896: 'failList', 3001939: 'failure_results', 3001895: 'failed_list', 3001858: 'failedList',
    3001385: 'failedList', 3001399: 'faildList', 3002032: 'failedList', 3001998: 'failedList',
  };
  if (failureArrays[id]) {
    const failures = data?.[failureArrays[id]];
    if (!Array.isArray(failures)) {
      fail('invalid_response', 'SHEIN did not return the item failure acknowledgement; inspect the affected resource before retrying');
    }
    return failures.length > 0;
  }
  if (id === 3001892) {
    if (!Number.isSafeInteger(data?.failCount) || !Number.isSafeInteger(data?.successCount)) {
      fail('invalid_response', 'SHEIN did not acknowledge the price negotiation');
    }
    return data.failCount > 0;
  }
  if ([3001852, 3001176, 3001908].includes(id)) return String(data?.code) !== '0';
  if (id === 3001360) return typeof data.failure_reason === 'string' && data.failure_reason.length > 0;
  return false;
}

export async function executeNative(credentials: Credentials, name: string,
  parameters: Record<string, unknown>, contract: ContractMethod): Promise<unknown> {
  validateNative(parameters, name, contract.input_schema);
  let body: unknown = (parameters as { body?: unknown }).body;
  if (contract.id === 3001738 || contract.id === 3001692) {
    stockArguments(body as Record<string, unknown>, contract.id === 3001738 ? 2 : 1);
  }
  if (contract.id === 3001921) {
    const typed = body as Record<string, unknown>;
    const parse = (value: unknown): number =>
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(value))
        ? Date.parse(String(value).replace(' ', 'T') + '+08:00') : NaN;
    const start = parse(typed.startTime);
    const end = parse(typed.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 48 * 3600000) {
      fail('validation_failed', 'SHEIN order time range must be positive and at most 48 hours');
    }
  }
  if (contract.multipart) {
    const typed = body as { file?: { content_base64?: unknown; name?: unknown } } | undefined;
    const file = typed?.file;
    if (!file) fail('validation_failed', 'Invalid SHEIN upload parameters; supply an inline file');
    const bytes = Buffer.from(String(file.content_base64), 'base64');
    if (bytes.toString('base64') !== file.content_base64) {
      fail('validation_failed', 'Invalid SHEIN upload parameters; use canonical base64');
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(typed as Record<string, unknown>)) {
      form.set(key, key === 'file' ? new Blob([bytes]) : String(value),
        ...(key === 'file' ? [String(file.name)] : []));
    }
    body = form;
  } else if (Object.hasOwn((contract.input_schema as { properties?: Record<string, unknown> }).properties || {}, 'body')
    && body === undefined) {
    body = {};
  }
  const path = contract.id === 3001905
    ? '/open-api/goods/delete/' + encodeURIComponent(String((parameters as { path?: { skcName?: unknown } }).path?.skcName))
    : contract.path;
  const data = await request(credentials, path, body,
    { contract, query: (parameters as { query?: Record<string, unknown> }).query });
  const failed = contract.risk !== 'R' && nativeFailure(contract, data, parameters);
  return {
    ...(contract.risk === 'R' ? {} : { status: failed ? 'partial_or_failed' : 'acknowledged' }),
    data: businessOutput(data, credentials, [3001589, 3001380].includes(contract.id)),
  };
}

export function methodFor(name: string): ContractMethod | undefined {
  return nativeMethods()[name];
}
