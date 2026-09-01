'use strict';
// End-to-end smoke test of the SALES BOT in simulation mode, against the
// MOCK Dealer Portal. Run with: npm run smoke
// Uses a throwaway data dir — never touches data/.
// Hermetic: force SIMULATION + mock portal no matter what the real .env says.
process.env.CUSTOMER_BOT_NUMBER = '';
process.env.ENABLE_EXTRA_BOTS = 'false';
process.env.CUSTOMER_TRANSPORT = 'linked'; // never the live Cloud API
process.env.WA_CLOUD_TOKEN = '';
process.env.WA_PHONE_NUMBER_ID = '';
process.env.WEBHOOK_RELAY_URL = '';
process.env.DEALER_PORTAL_BASE_URL = ''; // force mock portal
process.env.DEALER_PORTAL_TOKEN = '';
process.env.DEALER_PORTAL_USERNAME = '';
process.env.DEALER_PORTAL_PASSWORD = '';
process.env.ANTHROPIC_API_KEY = ''; // deterministic parsers only

const path = require('path');
const fs = require('fs');
const os = require('os');

const config = require('../src/config');
config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoflow-smoke-'));
config.customerGroups = ['delhi dealers'];
config.customerDms = ['919899555001'];
config.adminNumbers = ['919800000009'];
config.escalationNumber = '917004130460';

const store = require('../src/store');
const portal = require('../src/integrations/dealerPortal');
const knowledge = require('../src/core/knowledge');
const inquiries = require('../src/core/inquiries');
const CustomerBot = require('../src/bots/customerBot');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '  PASS ' : '  FAIL ') + name);
  if (!cond) failures++;
}
const lastOut = (bot) => (bot.transport.outbox[bot.transport.outbox.length - 1] || {}).text || '';
const sent = (bot) => bot.transport.outbox.map((o) => o.text).join('\n---\n');

async function dm(bot, from, body) {
  await bot.transport.injectIncoming({
    from,
    chatId: 'sim-' + from,
    chatName: '',
    isGroup: false,
    body,
    hasMedia: false,
    mediaType: 'chat',
  });
}
async function group(bot, from, body) {
  await bot.transport.injectIncoming({
    from,
    chatId: 'simgroup-delhi dealers',
    chatName: 'Delhi Dealers',
    isGroup: true,
    body,
    hasMedia: false,
    mediaType: 'chat',
  });
}

async function main() {
  console.log('\n--- Cartrends AutoFlow smoke test: SALES BOT + mock Dealer Portal ---\n');

  // The mock portal's "stock" — stands in for DP's analyze API.
  portal.setMockStock([
    { part_no: 'BP-1001', name: 'Brake Pad', quantity: 40, price: 450, mrp: 600, vendor: 'Northend' },
    { part_no: 'OF-2002', name: 'Oil Filter', quantity: 3, price: 210, mrp: 280, vendor: 'Mohan' },
    { part_no: '22400M74L00', name: 'Clutch Plate Swift', quantity: 12, price: 1850, mrp: 2400, vendor: 'Northend' },
    // KNOWN to the portal but ZERO stock — the founder's AC-gas case. This is
    // a sale loss, NOT a question for a human.
    { part_no: 'ACG-R134', name: 'AC Gas', quantity: 0, price: 0, mrp: 0, vendor: '' },
  ]);

  const customer = new CustomerBot();
  const bots = { customer };
  require('../src/core/admin').attach(bots);
  require('../src/core/escalation').attach(bots);
  await customer.start();

  const CUST = '919899555001';

  // ---- 1. availability from the portal ----
  console.log('[1] availability check');
  await dm(customer, CUST, 'brake pad available?');
  check('quotes availability from the portal', /available/i.test(lastOut(customer)));
  check('no local stock table is used', store.load().internalStock === undefined);

  // ---- 2. order -> draft ----
  console.log('\n[2] order capture');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'Brake Pad - 5\nOil Filter - 10');
  const draftMsg = lastOut(customer);
  check('draft created and shown', /Brake Pad x 5/i.test(draftMsg));
  check('partial line flagged (only 3 of 10 oil filters)', /only 3 now/i.test(draftMsg));

  // ---- 3. modification ----
  console.log('\n[3] in-chat modification');
  await dm(customer, CUST, 'Brake Pad to 8');
  check('quantity updated', /Brake Pad x 8/i.test(lastOut(customer)));
  await dm(customer, CUST, 'remove oil filter');
  check('line removed', !/Oil Filter/i.test(lastOut(customer)));

  // ---- 4. sale-loss logging ----
  console.log('\n[4] sale loss (the founder\'s AC-gas problem)');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'AC Gas - 4');
  const lost = inquiries.lostSales(1);
  check('unavailable item recorded as sale loss', lost.some((r) => /ac gas/i.test(r.item)));
  check('customer told it is on order ~1 week', /1 week|on order/i.test(sent(customer)));

  // ---- 5. confirm -> SO punched ----
  console.log('\n[5] confirmation punches the sales order');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'yes');
  const confirmMsg = lastOut(customer);
  check('SO number returned to the customer', /SO-\d+/.test(confirmMsg));
  const order = store.orders().find((o) => o.status === 'confirmed');
  check('order marked confirmed with an SO number', Boolean(order && order.soNumber));
  check('back-ordered item reserved, not dropped', /reserved/i.test(confirmMsg));

  // ---- 6. two-status rule ----
  console.log('\n[6] status replies (founder: only TWO statuses)');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'order kahan hai');
  const st = lastOut(customer);
  check('no vendor-leg detail leaks to the customer', !/vendor|invoiced|in_transit|billed/i.test(st));
  order.status = 'packed';
  store.save();
  await dm(customer, CUST, 'status');
  check('packed status reported', /packed and ready for dispatch/i.test(lastOut(customer)));

  // ---- 7. escalation learns permanently ----
  console.log('\n[7] escalation is asked ONCE, then learned forever');
  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'clutch set dzire petrol - 2');
  const askedText = sent(customer);
  check('helper was asked', /Confirm chahiye/i.test(askedText));
  // read the real escalation id rather than assuming it is E1
  const eid = (askedText.match(/E(\d+) — Confirm/) || [])[1];
  check('escalation id captured', Boolean(eid));
  // helper answers with the real part number
  await dm(customer, '917004130460', `E${eid} 22400M74L00`);
  check('answer learned permanently', knowledge.lookupAlias('clutch set dzire petrol') === '22400M74L00');

  customer.transport.outbox.length = 0;
  await dm(customer, CUST, 'clutch set dzire petrol - 3');
  check('same question NOT escalated again', !/Confirm chahiye/i.test(sent(customer)));
  check('answered straight from memory', /Clutch Plate Swift|confirm/i.test(sent(customer)));

  // ---- 8. group safety ----
  console.log('\n[8] safety');
  customer.transport.outbox.length = 0;
  await customer.transport.injectIncoming({
    from: '919899000777',
    chatId: 'simgroup-random',
    chatName: 'Some Other Group',
    isGroup: true,
    body: 'Brake Pad - 5',
    hasMedia: false,
    mediaType: 'chat',
  });
  check('silent in non-whitelisted groups', customer.transport.outbox.length === 0);
  await group(customer, '919899000888', 'good morning');
  check('silent on chit-chat in whitelisted groups', customer.transport.outbox.length === 0);

  // ---- 9. admin ----
  console.log('\n[9] admin over WhatsApp');
  customer.transport.outbox.length = 0;
  await dm(customer, '919800000009', 'LOSS 1');
  check('sale-loss report available to admin', /Sale loss/i.test(lastOut(customer)));
  await dm(customer, '919800000009', 'LEARN ac gas r134 = ACG-R134');
  check('admin can teach a part', knowledge.lookupAlias('ac gas r134') === 'ACG-R134');

  console.log(
    failures === 0
      ? '\n✅ ALL CHECKS PASSED\n'
      : `\n❌ ${failures} CHECK(S) FAILED\n`
  );
  try {
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke test crashed:', e);
  process.exit(1);
});
