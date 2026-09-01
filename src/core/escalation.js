'use strict';
// Human-confirm escalation, with PERMANENT learning.
//
//   Bot cannot identify a part -> DM the helper (ESCALATION_NUMBER)
//   -> helper answers within ESCALATION_TIMEOUT_MIN -> customer gets it
//   -> AND the answer is written into core/knowledge.js forever, so the
//      same question is never escalated to a human a second time.
//
// Founder: "hamesha ke liye vo knowledge mein store ho jana chahiye, taki
// agli baar usse koi same sawal poochhe to vapas mujhse na poochhe."
//
// Helper reply format (in the bot's DM):
//   E3 2               -> escalation #3, pick option 2
//   E3 55810M75J30     -> escalation #3, this is the right part
//   E3 no              -> escalation #3, not available
//   (with only one escalation pending, the "E3" prefix is optional)
const config = require('../config');
const store = require('../store');
const knowledge = require('./knowledge');

let seq = 0;
const pending = new Map();

function hasPending() {
  return pending.size > 0;
}

// A transport that can actually DM the helper: a CONNECTED line that is not
// the helper's own number (a self-DM never comes back).
function pickSender(customerBot) {
  const bots = customerBot._allBots || {};
  for (const b of Object.values(bots)) {
    const t = b.transport;
    if (t && t.mode === 'LIVE' && t.state === 'connected' && t.number && t.number !== config.escalationNumber) {
      return t;
    }
  }
  if (customerBot.transport.mode === 'SIMULATION') return customerBot.transport; // tests
  return null;
}

// Suggest previously learned phrases that look related.
function candidatesFor(item) {
  const tokens = String(item).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  if (!tokens.length) return [];
  const hits = [];
  for (const name of knowledge.aliasNames()) {
    if (tokens.some((t) => name.includes(t))) hits.push(name);
    if (hits.length >= 3) break;
  }
  return hits;
}

async function create(customerBot, { chatId, item, qty, kind }) {
  // Already learned? Then never ask a human again — this is the whole point.
  const learned = knowledge.lookupAlias(item);
  if (learned) {
    knowledge.noteAliasHit(item);
    store.log('escalate', `"${item}" already learned -> ${learned}; no human needed`);
    await resolveWithAnswer(
      { customerBot, chatId, item, qty: qty || 1, kind: kind || 'order' },
      learned,
      'memory'
    );
    return null;
  }

  const id = ++seq;
  const candidates = candidatesFor(item);
  const e = { id, customerBot, chatId, item, qty: qty || 1, kind: kind || 'order', candidates, timer: null };
  pending.set(id, e);

  let msg = `⚠️ *E${id} — Confirm chahiye*\nCustomer ne poocha: "${item}"${qty ? ` (qty ${qty})` : ''}\n`;
  if (candidates.length) {
    msg += `Milte-julte parts:\n` + candidates.map((c, i) => `${i + 1}) ${c}`).join('\n') + '\n';
  } else {
    msg += `Koi match nahi mila.\n`;
  }
  msg += `Reply: *E${id} <option no. ya sahi part number>*  |  *E${id} no* = available nahi. (${Math.round(
    config.escalationTimeoutMs / 60000
  )} min)`;

  const sender = pickSender(customerBot);
  if (!sender) {
    pending.delete(id);
    store.log('escalate', `E${id}: no connected line to reach the helper — direct fallback reply`);
    await fallbackReply(e);
    return null;
  }
  try {
    await sender.sendText(config.escalationNumber, msg);
    store.log('escalate', `E${id} sent to helper for "${item}" (${e.kind})`);
  } catch (err) {
    pending.delete(id);
    store.log('escalate', `E${id}: helper send failed (${String(err.message || err).slice(0, 80)})`);
    await fallbackReply(e);
    return null;
  }

  e.timer = setTimeout(() => onTimeout(id), config.escalationTimeoutMs);
  return id;
}

async function fallbackReply(e) {
  await e.customerBot.transport.sendToChat(
    e.chatId,
    `"${e.item}" abhi confirm nahi ho paya. Kripya exact part number share karein, hum turant check karke batayenge. 🙏`
  );
}

async function onTimeout(id) {
  const e = pending.get(id);
  if (!e) return;
  pending.delete(id);
  store.log('escalate', `E${id} timed out — falling back to the customer`);
  await fallbackReply(e);
}

// Apply a resolved part number for an escalation and answer the customer.
async function resolveWithAnswer(e, chosen, source) {
  const orders = require('./orders');
  const availability = require('./availability');
  const reply = (t) => e.customerBot.transport.sendToChat(e.chatId, t);

  // LEARN IT — the next customer asking this never reaches a human.
  if (source !== 'memory') knowledge.learnAlias(e.item, chosen, source || 'helper');

  if (e.kind === 'inquiry') {
    return reply(await e.customerBot.answerInquiry([chosen], null));
  }

  const resolved = await availability.resolve([{ item: chosen, qty: e.qty }]);
  const line = resolved[0];
  if (!line || line.source === 'unknown') {
    return reply(`"${chosen}" abhi confirm nahi ho paya. Team aapse jald sampark karegi.`);
  }
  const order = orders.getOrCreateDraft(e.chatId, e.chatId.replace(/^sim-/, ''));
  orders.addLines(order, [line]);
  return reply(`✅ Confirm ho gaya:\n${orders.summary(order)}\n\nReply *YES* to confirm the order.`);
}

// Reply from the helper number (registered on every transport, claims first).
async function handleReply(m) {
  if (m.isGroup || store.normPhone(m.from) !== config.escalationNumber || !pending.size) return false;
  const text = (m.body || '').trim();

  let id = null;
  let answer = '';
  const mm = text.match(/^E?(\d+)\s+([\s\S]+)$/i);
  if (mm && pending.has(parseInt(mm[1], 10))) {
    id = parseInt(mm[1], 10);
    answer = mm[2].trim();
  } else if (pending.size === 1) {
    id = [...pending.keys()][0];
    answer = text;
  } else {
    return false; // several pending, cannot tell which — let others see it
  }

  const e = pending.get(id);
  clearTimeout(e.timer);
  pending.delete(id);

  if (/^(no|nahi|nhi|not available|na)\b/i.test(answer)) {
    await e.customerBot.transport.sendToChat(
      e.chatId,
      `"${e.item}" abhi available nahi hai. Aap chahen to alternate part number share karein.`
    );
    store.log('escalate', `E${id} helper said NOT available`);
    return true;
  }

  // an option number, or the part number typed directly
  let chosen = answer;
  const opt = answer.match(/^(\d)$/);
  if (opt && e.candidates[parseInt(opt[1], 10) - 1]) chosen = e.candidates[parseInt(opt[1], 10) - 1];

  await resolveWithAnswer(e, chosen, 'helper');
  store.log('escalate', `E${id} resolved by helper -> "${chosen}" (learned)`);
  return true;
}

function attach(bots) {
  for (const t of new Set(Object.values(bots).map((b) => b.transport))) {
    t.onMessage((m) => handleReply(m));
  }
  for (const b of Object.values(bots)) b._allBots = bots; // for pickSender
}

module.exports = { attach, create, hasPending, handleReply };
