/** The eight legacy (hand-written) actions: shop, products, orders, warehouses, inventory.
 *  Ported from the Orkas `shein-seller-api.cjs` legacy branch; logic is unchanged. */
import { request } from '../client.js';
import { redactAll } from '../output.js';
import { validateLegacy } from '../validate.js';
import { fail, type ActionSpec, type Credentials } from '../types.js';

const ID = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
const TIME = { type: 'integer', minimum: 1577836800, maximum: 4102444800,
  description: 'Unix epoch seconds; converted to the required UTC+8 provider time.' };
const PAGE = { page: { type: 'integer', minimum: 1, maximum: 100000 },
  limit: { type: 'integer', minimum: 1, maximum: 10 } };

const action = (risk: ActionSpec['risk'], description: string, properties: Record<string, unknown> = {},
  required: string[] = []): ActionSpec =>
  ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });

export function legacyActionsFor(): Record<string, ActionSpec> {
  return {
    'shop.get': action('R', 'Verify the authorized SHEIN grant and read available selling sites and currencies.'),
    'products.list': action('R', 'Read one SPU page including SKU codes, stock, prices and marketing locks. Provider page size is at most 10.', PAGE),
    'products.get': action('R', 'Read one SPU and its SKCs/SKUs using the SPU code returned by products.list.', { spu_code: ID }, ['spu_code']),
    'orders.list': action('R', 'Read an order page for an explicit time window no longer than 48 hours. Provider caps a window at 10000 orders; narrow the time range when necessary.', { ...PAGE, start_time: TIME, end_time: TIME, query_type: { type: 'integer', minimum: 1, maximum: 2, description: '1 = order creation; 2 = order update. Defaults to 1.' } }, ['start_time', 'end_time']),
    'orders.get': action('R', 'Read one order and line-item amounts without buyer contacts, labels or payment links.', { order_id: ID }, ['order_id']),
    'warehouses.list': action('R', 'Read warehouse codes, types and supported countries. Only merchant warehouses support inventory writes.'),
    'inventory.get': action('R', 'Read merchant virtual stock, reserved quantities and available quantities for one SKU.', { sku_code: ID }, ['sku_code']),
    'inventory.overwrite': action('H', 'Request a total merchant virtual stock overwrite after fresh confirmation. SHEIN will not reduce below reserved/occupied stock. The acknowledged quantity is a request, not a guarantee of resulting stock; read inventory.get afterward. Does not change SHEIN physical or JIT stock.',
      { sku_code: ID, warehouse_code: ID, quantity: { type: 'integer', minimum: 1, maximum: 2147483647 }, request_key: { ...ID, minLength: 8, description: 'Unique idempotency key for this confirmed change; never reuse it for a different change.' } }, ['sku_code', 'warehouse_code', 'quantity', 'request_key']),
  };
}

function pick(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => pick(item, keys));
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key))
      .map(([key, child]) => [key, pick(child, keys)]))
    : value;
}

const ORDER_KEYS = ['count', 'orderList', 'orderNo', 'orderStatus', 'orderCreateTime', 'orderUpdateTime', 'stockMode', 'orderType', 'salesSite', 'orderGoodsInfoList', 'skuCode', 'skc', 'sellerSku', 'newGoodsStatus', 'goodsExchangeTag', 'goodsTitle', 'spuName', 'orderCurrency', 'saleCurrency', 'sellerCurrencyPrice', 'costPrice', 'productTotalPrice', 'totalCostPrice', 'productQuantity', 'warehouseCode', 'orderCurrencyStoreCouponPrice', 'orderCurrencyPromotionPrice'];

const utc8 = (seconds: number): string =>
  new Date(seconds * 1000 + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');

export async function identity(credentials: Credentials): Promise<unknown> {
  const data = await request(credentials, '/open-api/goods/query-site-list', {});
  const typed = data as { data?: unknown; meta?: { count?: unknown } };
  if (!Array.isArray(typed?.data) || !Number.isSafeInteger(typed.meta?.count)) {
    fail('invalid_response', 'SHEIN site identity is missing');
  }
  return {
    supplier_id: credentials.identity.supplier_id,
    sites: pick(typed.data, ['main_site', 'sub_site_list', 'currency', 'site_abbr', 'site_status', 'store_type']),
  };
}

export async function executeLegacy(credentials: Credentials, name: string, p: Record<string, unknown>): Promise<unknown> {
  const spec = legacyActionsFor()[name];
  validateLegacy(p, spec.input_schema);
  if (name === 'shop.get') return identity(credentials);
  if (name === 'orders.list' && ((p.end_time as number) <= (p.start_time as number)
    || (p.end_time as number) - (p.start_time as number) > 48 * 3600)) {
    fail('validation_failed', 'SHEIN order time range must be positive and at most 48 hours');
  }
  const page = (p.page as number) || 1;
  const limit = (p.limit as number) || 10;
  let data: unknown;
  if (name === 'products.list' || name === 'products.get') {
    data = await request(credentials, '/open-api/goods/searchProduct', {
      pageNum: name === 'products.get' ? 1 : page,
      pageSize: name === 'products.get' ? 1 : limit,
      ...(p.spu_code ? { spuNameList: [p.spu_code] } : {}),
    });
    const typed = data as { data?: Array<{ spuName?: unknown }>; meta?: { count?: unknown } };
    if (!Array.isArray(typed?.data) || !Number.isSafeInteger(typed.meta?.count)
      || (name === 'products.get' && (typed.data.length !== 1 || typed.data[0].spuName !== p.spu_code))) {
      fail('invalid_response', 'SHEIN product or pagination is missing');
    }
  } else if (name === 'orders.list') {
    data = await request(credentials, '/open-api/order/order-list', {
      queryType: p.query_type || 1, startTime: utc8(p.start_time as number),
      endTime: utc8(p.end_time as number), page, pageSize: limit, queryOrderType: 4,
    });
    const typed = data as { orderList?: unknown; count?: unknown };
    if (!Array.isArray(typed?.orderList) || !Number.isSafeInteger(typed.count)) {
      fail('invalid_response', 'SHEIN order pagination is missing');
    }
    data = pick(data, ORDER_KEYS);
  } else if (name === 'orders.get') {
    data = await request(credentials, '/open-api/order/order-detail', { orderNoList: [p.order_id] });
    const typed = data as Array<{ orderNo?: unknown }>;
    if (!Array.isArray(typed) || typed.length !== 1 || typed[0].orderNo !== p.order_id) {
      fail('invalid_response', 'SHEIN order identity is missing');
    }
    data = pick(typed[0], ORDER_KEYS);
  } else if (name === 'warehouses.list') {
    data = await request(credentials, '/open-api/msc/warehouse/list');
    const typed = data as { list?: unknown };
    if (!Array.isArray(typed?.list)) fail('invalid_response', 'SHEIN warehouse list is missing');
    data = pick(data, ['list', 'saleCountryList', 'warehouseCode', 'warehouseName', 'warehouseType']);
  } else if (name === 'inventory.get') {
    data = await request(credentials, '/open-api/stock/stock-query', { skuCodeList: [p.sku_code], invType: 'VI' });
    const typed = data as { goodsInventory?: unknown };
    if (!Array.isArray(typed?.goodsInventory)) fail('invalid_response', 'SHEIN inventory is missing');
  } else {
    // Require an existing merchant warehouse; do not accidentally mutate a certified warehouse.
    const warehouses = await request(credentials, '/open-api/msc/warehouse/list');
    const typed = warehouses as { list?: Array<{ warehouseCode?: unknown; warehouseType?: unknown }> };
    if (!Array.isArray(typed?.list) || !typed.list.some((w) => w.warehouseCode === p.warehouse_code && String(w.warehouseType) === '1')) {
      fail('validation_failed', 'SHEIN inventory writes require a verified merchant warehouse');
    }
    data = await request(credentials, '/open-api/stock/change-inventory/v2', {
      updateSkuInventoryQuantityRequests: [{
        idempotencyKey: p.request_key, skuCode: p.sku_code, invType: 'VI',
        warehouseCode: p.warehouse_code, changeType: 'OVERWRITE', changeQuantity: p.quantity,
      }],
    }, { write: true });
    const result = data as { failedList?: unknown };
    if (!Array.isArray(result?.failedList) || result.failedList.length) {
      fail('upstream_error', 'SHEIN inventory write was not fully acknowledged; inspect stock before retrying');
    }
    data = {
      status: 'acknowledged', sku_code: p.sku_code, warehouse_code: p.warehouse_code,
      requested_total: p.quantity,
      resulting_stock: 'Read inventory.get; reserved and occupied stock may raise the resulting total.',
    };
  }
  const sanitized = redactAll(data, credentials);
  return { data: sanitized, ...(['products.list', 'orders.list'].includes(name) ? { page, limit } : {}) };
}
