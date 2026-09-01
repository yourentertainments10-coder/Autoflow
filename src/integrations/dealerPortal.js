'use strict';
// Dealer Portal client — the ONLY source of stock and the ONLY place a sales
// order is punched. This process holds no stock of its own.
//
//   login    POST /auth/login                 -> access_token          [VERIFIED]
//   analyze  POST <DEALER_PORTAL_ANALYZE_PATH> -> vendor availability  [SHAPE ASSUMED]
//   confirm  POST <DEALER_PORTAL_CONFIRM_PATH> -> sales order punched  [SHAPE ASSUMED]
//
// ---------------------------------------------------------------------------
// !! THE ONE PLACE TO EDIT WHEN ANEEQ SIR SHARES THE REAL analyze/confirm SPEC
//
// Only `buildAnalyzeRequest` / `readAnalyzeResponse` / `buildConfirmRequest` /
// `readConfirmResponse` below know the wire format. Everything else in the
// codebase talks through the normalised shapes:
//
//   analyze(lines) -> [{ item, partNo, qty, available, vendors:[{name, qty,
//                        price, mrp, tatDays}], mrp, price, source, eta }]
//   confirm(order) -> { soNumber }
//
// The endpoint PATHS are already env-configurable (see config.dealerPortal),
// so a path change needs no code edit at all.
// ---------------------------------------------------------------------------
//
// With no DEALER_PORTAL_BASE_URL set the module runs in MOCK mode: analyze
// answers from data/mock-stock.json (if present) and confirm issues local
// SO- numbers, so the whole sales flow still runs end-to-end offline.
const config = require('../config');
const store = require('../store');

const dp = config.dealerPortal;

function enabled() {
  return Boolean(dp.baseUrl && (dp.token || (dp.username && dp.password)));
}
const isMock = () => !enabled();

// ---------------------------------------------------------------- transport

let cachedToken = null;

async function login() {
  // A permanent / refresh token skips the interactive login entirely.
  if (dp.token) {
    cachedToken = dp.token;
    return cachedToken;
  }
  const res = await fetch(dp.baseUrl + dp.loginPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: dp.username,
      password: dp.password,
      device_id: dp.deviceId,
      device_info: 'Cartrends AutoFlow sales bot',
    }),
    signal: AbortSignal.timeout(dp.timeoutMs),
  });
  if (!res.ok) throw new Error('Dealer Portal login failed: HTTP ' + res.status);
  const data = await res.json();
  cachedToken = data.access_token || data.token;
  if (!cachedToken) throw new Error('Dealer Portal login returned no access_token');
  store.log('portal', 'Dealer Portal login OK');
  return cachedToken;
}

async function api(method, urlPath, body, retry = true) {
  if (!cachedToken) await login();
  const res = await fetch(dp.baseUrl + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cachedToken,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(dp.timeoutMs),
  });
  // A permanent token that 401s is a real failure, not an expiry — only retry
  // when we actually own a username/password to re-login with.
  if (res.status === 401 && retry && !dp.token && dp.username) {
    cachedToken = null;
    return api(method, urlPath, body, false);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dealer Portal ${method} ${urlPath} -> HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ------------------------------------------------------- wire format (EDIT ME)

// Per Aneeq sir: "part number aur quantity, do item ke saath analyze API call
// karega ... output yahi batayega ki kis vendor ke paas kitna stock available
// hai" — plus MRP and quantity per the same description.
function buildAnalyzeRequest(lines) {
  return {
    items: lines.map((l) => ({
      part_no: l.partNo || l.item,
      quantity: Number(l.qty) || 1,
    })),
  };
}

// Tolerant reader: accepts a few plausible field spellings so a small
// difference in the real response does not break the bot outright.
function readAnalyzeResponse(data, lines) {
  const rows = data.items || data.results || data.parts || (Array.isArray(data) ? data : []);
  return lines.map((line, i) => {
    const match = rows[i] || rows.find((r) => same(r.part_no || r.partNo, line.partNo || line.item)) || null;
    const row = match || {};
    const rawVendors = row.vendors || row.availability || [];
    const vendors = rawVendors
      .map((v) => ({
        name: v.vendor || v.vendor_name || v.dealer || v.name || 'Vendor',
        qty: num(v.live_remaining ?? v.quantity ?? v.qty ?? v.available),
        price: num(v.price ?? v.rate),
        mrp: num(v.mrp),
        tatDays: num(v.tat_days ?? v.tatDays),
      }))
      .filter((v) => v.qty > 0)
      .sort((a, b) => b.qty - a.qty);
    const available = vendors.reduce((s, v) => s + v.qty, 0);
    return normaliseLine(line, {
      known: Boolean(match),
      available,
      vendors,
      mrp: num(row.mrp),
      price: num(row.price ?? row.rate),
      partNo: row.part_no || row.partNo || line.partNo || line.item,
      name: row.part_name || row.name || null,
    });
  });
}

function buildConfirmRequest(order) {
  return {
    customer: order.customer,
    reference: order.id,
    // A zero-stock line IS sent — the founder reserves it for the customer
    // ("confirm karo to aapke liye rok deta hun"). Only lines we could not
    // identify are withheld, since we have no part number to send.
    items: order.lines
      .filter((l) => l.source !== 'unidentified' && l.source !== 'unknown')
      .map((l) => ({ part_no: l.partNo || l.item, quantity: l.qty })),
  };
}

function readConfirmResponse(data) {
  const soNumber =
    data.so_number || data.soNumber || data.order_number || data.orderNumber || data.id || null;
  if (!soNumber) throw new Error('Dealer Portal confirm returned no order number');
  return { soNumber: String(soNumber) };
}

// ------------------------------------------------------------------ helpers

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function same(a, b) {
  return norm(a) && norm(a) === norm(b);
}
function norm(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

// One requested line + DP's answer -> the shape the rest of the app uses.
function normaliseLine(line, info) {
  const qty = Number(line.qty) || 1;
  const available = info.available || 0;
  const best = (info.vendors || [])[0] || null;
  const price = info.price || (best && best.price) || null;
  const mrp = info.mrp || (best && best.mrp) || null;

  if (available <= 0) {
    // CRITICAL DISTINCTION:
    //   known: false -> the portal does not know this part at all. A human
    //                   must identify it, and we learn the answer forever.
    //   known: true  -> the part exists, stock is zero. No human needed;
    //                   founder's answer is "on order, about 1 week".
    return {
      item: info.name || line.item,
      partNo: info.partNo,
      qty,
      source: info.known ? 'unavailable' : 'unidentified',
      available: 0,
      vendors: [],
      price,
      mrp,
      // Founder's line: "ye order pe laga hua hai, abhi nahi hai, but aa
      // jayega 1 hafte mein. Aap confirm karo to aapke liye rok deta hun."
      eta: 'on order — about 1 week',
    };
  }
  const partial = available < qty;
  return {
    item: info.name || line.item,
    partNo: info.partNo,
    qty,
    source: 'portal',
    available,
    partial,
    vendors: info.vendors || [],
    vendorName: best ? best.name : null,
    price,
    mrp,
    eta: partial ? `only ${available} available now, rest on order` : 'available',
  };
}

// --------------------------------------------------------------- mock mode

// data/mock-stock.json: [{ part_no, name, quantity, price, mrp }]
let mockCache = null;
function mockStock() {
  if (mockCache) return mockCache;
  try {
    const fs = require('fs');
    const path = require('path');
    mockCache = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'mock-stock.json'), 'utf-8'));
  } catch {
    mockCache = [];
  }
  return mockCache;
}
function setMockStock(rows) {
  mockCache = Array.isArray(rows) ? rows : [];
  return mockCache.length;
}

function mockAnalyze(lines) {
  return lines.map((line) => {
    const key = line.partNo || line.item;
    const row =
      mockStock().find((r) => same(r.part_no, key)) ||
      mockStock().find((r) => {
        const a = String(r.name || '').toLowerCase();
        const b = String(key).toLowerCase();
        return a && b && (a === b || a.includes(b) || b.includes(a));
      });
    if (!row) return normaliseLine(line, { known: false, available: 0, vendors: [], partNo: key });
    const qty = num(row.quantity);
    return normaliseLine(line, {
      known: true,
      available: qty,
      vendors: qty > 0 ? [{ name: row.vendor || 'Portal', qty, price: num(row.price), mrp: num(row.mrp), tatDays: 0 }] : [],
      price: num(row.price),
      mrp: num(row.mrp),
      partNo: row.part_no || key,
      name: row.name || line.item,
    });
  });
}

// ------------------------------------------------------------------- public

module.exports = {
  enabled,
  get isMock() {
    return isMock();
  },
  setMockStock,

  // Ask the portal what is available. Never throws — on failure every line
  // comes back 'unknown' so the bot escalates instead of promising wrongly.
  async analyze(lines) {
    if (!lines || !lines.length) return [];
    if (isMock()) return mockAnalyze(lines);
    try {
      const data = await api('POST', dp.analyzePath, buildAnalyzeRequest(lines));
      return readAnalyzeResponse(data, lines);
    } catch (e) {
      store.log('portal', 'analyze failed: ' + String(e.message || e).slice(0, 160));
      return lines.map((line) => ({
        item: line.item,
        partNo: line.partNo || line.item,
        qty: Number(line.qty) || 1,
        source: 'unknown',
        available: 0,
        vendors: [],
        eta: 'checking',
      }));
    }
  },

  // Punch the confirmed sales order. Throws on failure — the caller must NOT
  // tell the customer an order exists unless the portal actually made one.
  async confirm(order) {
    if (isMock()) {
      const soNumber = 'SO-' + store.nextSeq('so');
      store.log('portal', `MOCK sales order punched: ${soNumber} (${order.lines.length} lines)`);
      return { soNumber };
    }
    const data = await api('POST', dp.confirmPath, buildConfirmRequest(order));
    const result = readConfirmResponse(data);
    store.log('portal', `sales order punched: ${result.soNumber}`);
    return result;
  },
};
