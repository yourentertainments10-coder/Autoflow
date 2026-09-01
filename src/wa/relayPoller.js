'use strict';
// Render relay se incoming Cloud API webhooks kheenchta hai (har ~3 sec)
// aur cloud transports ko de deta hai — public URL PC tak laane ka
// "for now" rasta (baad mein AWS par direct webhook lagega).
const config = require('../config');
const store = require('../store');

function start(bots) {
  if (!config.relay.url || !config.relay.secret) return;
  const cloudTransports = [...new Set(Object.values(bots).map((b) => b.transport))].filter(
    (t) => t.mode === 'CLOUD'
  );
  if (!cloudTransports.length) {
    store.log('relay', 'relay URL set hai par koi CLOUD transport nahi (CUSTOMER_TRANSPORT=cloud karo) — poller off');
    return;
  }
  let failures = 0;
  setInterval(async () => {
    try {
      const res = await fetch(`${config.relay.url}/pull?secret=${encodeURIComponent(config.relay.secret)}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const events = await res.json();
      failures = 0;
      for (const evt of events) {
        for (const t of cloudTransports) await t.handleWebhook(evt.body).catch(() => {});
      }
      if (events.length) store.log('relay', `${events.length} webhook event(s) processed`);
    } catch (e) {
      failures++;
      if (failures === 5 || failures % 100 === 0) {
        store.log('relay', `poll failing (${failures}x): ${String(e.message || e).slice(0, 80)} — Render service so raha hoga, jagane ki koshish jaari`);
      }
    }
  }, Math.max(2000, config.relay.pollMs));
  store.log('relay', `webhook relay poller on: ${config.relay.url} (har ${config.relay.pollMs}ms)`);
}

module.exports = { start };
