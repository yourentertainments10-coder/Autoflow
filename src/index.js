'use strict';
// Cartrends AutoFlow — entrypoint.
//
// CURRENT SCOPE: the customer/sales bot only. It reads availability from the
// Dealer Portal and punches sales orders there. Vendor stock reaches the
// portal from ProcureHub, not from this process.
//
// The purchase / warehouse / finance / helpdesk bots are PARKED — their code
// is intact but they do not boot unless ENABLE_EXTRA_BOTS=true.
const config = require('./config');
const store = require('./store');
const scheduler = require('./core/scheduler');
const consoleServer = require('./console/server');
const portal = require('./integrations/dealerPortal');

const CustomerBot = require('./bots/customerBot');

function buildBots() {
  const bots = { customer: new CustomerBot() };
  if (!config.enableExtraBots) return bots;

  // Parked roles, switched on explicitly.
  bots.purchase = new (require('./bots/purchaseBot'))();
  bots.warehouse = new (require('./bots/warehouseBot'))();
  bots.finance = new (require('./bots/financeBot'))();
  bots.helpdesk = new (require('./bots/helpdeskBot'))();
  return bots;
}

async function main() {
  store.load();
  store.log('boot', '=== Cartrends AutoFlow starting (sales bot) ===');
  for (const key of config.BOTS) {
    store.log(
      'boot',
      `${config.bots[key].label}: ${config.isLive(key) ? 'LIVE as ' + config.bots[key].number : 'SIMULATION (no number in .env)'}`
    );
  }
  store.log(
    'boot',
    portal.enabled()
      ? 'Dealer Portal: LIVE — availability and order punching go to the portal'
      : 'Dealer Portal: MOCK (no DEALER_PORTAL_BASE_URL/credentials) — using data/mock-stock.json'
  );
  if (!config.enableExtraBots) {
    store.log('boot', 'purchase / warehouse / finance / helpdesk are PARKED (set ENABLE_EXTRA_BOTS=true to run them)');
  }

  const bots = buildBots();

  // admin-over-WhatsApp registers FIRST so admin commands outrank bot roles
  const admin = require('./core/admin');
  admin.attach(bots);
  require('./core/escalation').attach(bots); // helper replies claim before roles

  consoleServer.start(bots); // dev/testing console — production runs headless
  scheduler.start({ bots, admin });

  // start live bots sequentially (each spawns a headless browser); sims are instant
  for (const bot of Object.values(bots)) {
    try {
      await bot.start();
    } catch (e) {
      store.log('boot', `${bot.key} failed to start: ${e.message}`);
    }
  }

  require('./wa/relayPoller').start(bots); // Cloud API incoming via Render relay

  store.log('boot', 'ready. Console: http://localhost:' + config.consolePort);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
