'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function digits(v) {
  return String(v || '').replace(/\D/g, '');
}
function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
function times(v, fallback) {
  const out = list(v).filter((t) => /^\d{1,2}:\d{2}$/.test(t));
  return out.length ? out : fallback;
}
function bool(v, dflt = false) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return dflt;
  return s === 'true' || s === '1' || s === 'yes';
}

// SCOPE (Aneeq sir, current phase): only the customer/sales bot is in play.
// purchase / warehouse / finance / helpdesk are PARKED — their code is kept
// but they are not started unless ENABLE_EXTRA_BOTS=true. Vendor stock now
// lives in the Dealer Portal (pushed there by ProcureHub), so this process
// no longer collects stock, places POs, or chases invoices.
const SALES_BOTS = ['customer'];
const EXTRA_BOTS = ['purchase', 'warehouse', 'finance', 'helpdesk'];

const config = {
  tz: process.env.TZ || 'Asia/Kolkata',
  // Render (and most PaaS) inject PORT. CONSOLE_PORT stays as the local name.
  consolePort: parseInt(process.env.PORT || process.env.CONSOLE_PORT || '3010', 10),
  // DATA_DIR lets the state file live on a mounted persistent disk in
  // production (Render disk), instead of inside the deploy directory which
  // is wiped on every deploy.
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Parked bots stay off unless explicitly switched on.
  enableExtraBots: bool(process.env.ENABLE_EXTRA_BOTS, false),

  bots: {
    purchase: { number: digits(process.env.PURCHASE_BOT_NUMBER), label: 'Purchase Bot (414)' },
    customer: { number: digits(process.env.CUSTOMER_BOT_NUMBER), label: 'Customer Bot (421)' },
    warehouse: { number: digits(process.env.WAREHOUSE_BOT_NUMBER), label: 'Warehouse Bot' },
    finance: { number: digits(process.env.FINANCE_BOT_NUMBER), label: 'Finance Bot' },
    helpdesk: { number: digits(process.env.HELPDESK_BOT_NUMBER), label: 'HR/IT Helpdesk Bot' },
  },

  customerGroups: list(process.env.CUSTOMER_GROUPS).filter((g) => g.toLowerCase() !== 'all').map((g) => g.toLowerCase()),
  customerGroupsAll: list(process.env.CUSTOMER_GROUPS).some((g) => g.toLowerCase() === 'all'),
  // DM whitelist: sirf in numbers (ya LID digits) ke DMs process honge;
  // khali = koi DM nahi; "all" = sab DMs (sirf testing ke liye)
  customerDms: list(process.env.CUSTOMER_DMS).map(digits).filter(Boolean),
  customerDmsAll: list(process.env.CUSTOMER_DMS).some((v) => v.toLowerCase() === 'all'),
  warehouseTeamNumbers: list(process.env.WAREHOUSE_TEAM_NUMBERS).map(digits).filter(Boolean),
  internalWarehouseName: process.env.INTERNAL_WAREHOUSE_NAME || 'Bijwasan',

  stockBroadcastTimes: times(process.env.STOCK_BROADCAST_TIMES, ['09:30', '16:00']),
  ivrFollowupTimes: times(process.env.IVR_FOLLOWUP_TIMES, ['11:30', '17:30']),
  invoiceChaseCron: process.env.INVOICE_CHASE_CRON || '0 * * * *',

  // ---- Dealer Portal: the ONLY source of stock and the ONLY place orders
  // are punched. Vendor stock reaches it from ProcureHub, not from here.
  dealerPortal: {
    baseUrl: (process.env.DEALER_PORTAL_BASE_URL || '').trim().replace(/\/$/, ''),
    username: (process.env.DEALER_PORTAL_USERNAME || '').trim(),
    password: (process.env.DEALER_PORTAL_PASSWORD || '').trim(),
    // Permanent / refresh token. When set, no interactive login is performed.
    token: (process.env.DEALER_PORTAL_TOKEN || '').trim(),
    deviceId: (process.env.DEALER_PORTAL_DEVICE_ID || 'cartrends-autoflow-sales').trim(),
    // Endpoint paths are env-configurable ON PURPOSE: /auth/login is verified,
    // but the analyze/confirm paths are still to be confirmed with Aneeq sir.
    // When he shares them this is a .env change, not a code change.
    loginPath: (process.env.DEALER_PORTAL_LOGIN_PATH || '/auth/login').trim(),
    analyzePath: (process.env.DEALER_PORTAL_ANALYZE_PATH || '/orders/analyze').trim(),
    confirmPath: (process.env.DEALER_PORTAL_CONFIRM_PATH || '/orders/confirm').trim(),
    timeoutMs: parseInt(process.env.DEALER_PORTAL_TIMEOUT_MS || '20000', 10),
  },

  // Official WhatsApp Cloud API (Meta) — customer line ka production transport
  cloud: {
    token: (process.env.WA_CLOUD_TOKEN || '').trim(),
    phoneNumberId: (process.env.WA_PHONE_NUMBER_ID || '').trim(),
    wabaId: (process.env.WA_WABA_ID || '').trim(),
    verifyToken: (process.env.WA_VERIFY_TOKEN || 'cartrends-autoflow-verify').trim(),
  },
  // 'linked' (QR wala, default) ya 'cloud' (official API) — customer bot ke liye
  customerTransport: (process.env.CUSTOMER_TRANSPORT || 'linked').trim().toLowerCase(),

  // Render par chal raha webhook relay (incoming Cloud API messages ka rasta)
  relay: {
    url: (process.env.WEBHOOK_RELAY_URL || '').trim().replace(/\/$/, ''),
    secret: (process.env.WEBHOOK_RELAY_SECRET || '').trim(),
    pollMs: parseInt(process.env.WEBHOOK_RELAY_POLL_MS || '3000', 10),
  },

  adminNumbers: list(process.env.ADMIN_NUMBERS).map(digits).filter(Boolean),
  dailyReportTime: (process.env.DAILY_REPORT_TIME || '20:00').trim(),

  // human-confirm escalation: confusion par is number ko DM, itni der jawab
  // ka intezar, phir customer ko fallback reply. Helper ka jawab PERMANENTLY
  // seekha jaata hai (core/knowledge.js) — wahi sawal dobara nahi poocha jaata.
  escalationNumber: digits(process.env.ESCALATION_NUMBER || '917004130460'),
  escalationTimeoutMs: Math.max(10, parseFloat(process.env.ESCALATION_TIMEOUT_MIN || '5') * 60) * 1000,

  ivr: {
    provider: (process.env.IVR_PROVIDER || 'mock').trim().toLowerCase(),
    twilio: {
      sid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
      token: (process.env.TWILIO_AUTH_TOKEN || '').trim(),
      from: (process.env.TWILIO_FROM_NUMBER || '').trim(),
    },
  },

  ai: {
    apiKey: (process.env.ANTHROPIC_API_KEY || '').trim(),
    model: (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5').trim(),
  },
};

config.isLive = (botKey) => Boolean(config.bots[botKey] && config.bots[botKey].number);
config.SALES_BOTS = SALES_BOTS;
config.EXTRA_BOTS = EXTRA_BOTS;
// Bots actually booted this run.
config.BOTS = config.enableExtraBots ? [...SALES_BOTS, ...EXTRA_BOTS] : [...SALES_BOTS];

module.exports = config;
