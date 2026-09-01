'use strict';
// Customer Sales Bot — the replacement for the person currently answering
// customer WhatsApp groups by hand.
//
//   listens in whitelisted groups + DMs
//   -> reads orders as text, photo or spreadsheet
//   -> asks the DEALER PORTAL what is available (no local stock at all)
//   -> holds a draft order, lets the customer modify it in chat
//   -> final YES punches the sales order into the Dealer Portal
//
// Anything it cannot resolve goes to a human once, and the answer is learned
// permanently (core/knowledge.js) so the same question is never asked twice.
// Every requested line is logged for sale-loss reporting (core/inquiries.js).
const config = require('../config');
const store = require('../store');
const ai = require('../core/ai');
const availability = require('../core/availability');
const orders = require('../core/orders');
const knowledge = require('../core/knowledge');
const inquiries = require('../core/inquiries');
const escalation = require('../core/escalation');
const { createTransport } = require('../wa/transport');

class CustomerBot {
  constructor() {
    this.key = 'customer';
    this.transport = createTransport(this.key);
  }

  async start() {
    this.transport.onMessage((m) => this.handleMessage(m));
    await this.transport.start();
  }

  listensTo(m) {
    // SAFETY: DMs are whitelist-only — only CUSTOMER_DMS numbers (or LID
    // digits, which show up in the logs). "all" = testing mode.
    if (!m.isGroup) return config.customerDmsAll || config.customerDms.includes(store.normPhone(m.from));
    // SAFETY: groups must be explicitly whitelisted in CUSTOMER_GROUPS — the
    // bot's number may sit in unrelated real groups. Entries may be a group
    // name or a group id (digits from "1203...@g.us").
    if (config.customerGroupsAll) return true;
    if (!config.customerGroups.length) return false;
    const name = (m.chatName || '').toLowerCase();
    const id = (m.chatId || '').toLowerCase();
    return config.customerGroups.some((g) => g === name || (g.length > 8 && id.includes(g)));
  }

  async handleMessage(m) {
    if (!this.listensTo(m)) return false;
    const botNumbers = Object.values(config.bots).map((b) => b.number).filter(Boolean);
    if (botNumbers.includes(m.from)) return false;

    const reply = async (t) => {
      await this.transport.sendToChat(m.chatId, t);
      return true;
    };

    // voice notes: not understood yet — guide in DMs, stay silent in groups
    if (['ptt', 'audio'].includes(m.mediaType)) {
      if (!m.isGroup) {
        return reply(
          'Abhi main voice message nahi samajh paata 🙏 Kripya order type karke bhejein (jaise: Brake Pad - 5) ya order ki photo bhej dein.'
        );
      }
      return false;
    }

    // photo order
    if (m.mediaBase64 && /^image\//.test(m.mediaMime || '')) {
      const lines = await ai.parseOrderImage(m.mediaBase64, m.mediaMime);
      if (lines && lines.length) {
        return this.processOrderLines(m, lines, reply, '📷 I read your order from the photo:');
      }
      if (!m.isGroup) {
        return reply(
          lines === null
            ? 'Photo reading is not enabled on this system yet. Please type the items like:\nBrake Pad - 5\nOil Filter - 2'
            : 'Sorry, I could not read an order from that photo. Please type the items like:\nBrake Pad - 5\nOil Filter - 2'
        );
      }
      return false;
    }

    const text = (m.body || '').trim();
    if (!text) return false;

    const parsed = await ai.parseCustomerMessage(text, availability.catalogNames());

    switch (parsed.intent) {
      case 'status':
        return reply(this.orderStatus(m));

      case 'inquiry': {
        const items = parsed.items || [];
        if (!items.length) {
          // Did a human already answer this exact question once? Then answer
          // from memory instead of asking them again.
          const known = knowledge.findNote(text);
          if (known) return reply(known.answer);
          const phrase = text.replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();
          if (phrase.length >= 4) {
            await escalation.create(this, { chatId: m.chatId, item: phrase, qty: 1, kind: 'inquiry' });
            return true;
          }
          if (m.isGroup) return false;
          return reply('Please tell me the part number or name and quantity, and I will check right away.');
        }
        return reply(await this.answerInquiry(items, m));
      }

      case 'order':
        return this.processOrderLines(m, parsed.lines || [], reply);

      case 'set_qty': {
        const order = orders.findDraft(m.chatId);
        if (order && (await orders.setQty(order, parsed.item, parsed.qty))) {
          return reply(`Updated.\n${orders.summary(order)}\n\nReply *YES* to confirm.`);
        }
        // Not a quantity change after all ("AC Gas to 4" with no such line in
        // the draft) — treat it as a new order line rather than rejecting the
        // customer with "couldn't find that".
        return this.processOrderLines(m, [{ item: parsed.item, qty: parsed.qty }], reply);
      }

      case 'remove': {
        const order = orders.findDraft(m.chatId);
        if (!order) return false;
        if (orders.removeItem(order, parsed.item)) {
          return reply(`Removed.\n${orders.summary(order)}\n\nReply *YES* to confirm.`);
        }
        return reply(`Couldn't find "${parsed.item}" in your order.`);
      }

      case 'confirm': {
        const order = orders.findDraft(m.chatId);
        if (!order || !order.lines.length) return false; // bare "yes" with no draft
        try {
          const { soNumber, backordered } = await orders.confirm(order);
          let msg = `✅ Order confirmed! Your Sales Order number is *${soNumber}*.`;
          if (backordered.length) {
            msg +=
              `\n\nReserved for you and coming on order (about 1 week): ` +
              backordered.map((l) => l.requested || l.item).join(', ') +
              `.`;
          }
          const also = this.crossSellFor(order.lines);
          if (also.length) {
            msg += `\n\n🛠 *You may also need:* ${also.join(', ')} — send quantities and we'll add them.`;
          }
          store.upsertCustomer(m.from);
          return reply(msg);
        } catch (e) {
          store.log(this.key, 'confirm failed: ' + e.message);
          // NEVER tell the customer an order exists when the portal refused.
          return reply(
            'Sorry, I could not place the order just now — our system did not accept it. ' +
              'Our team has been alerted and will confirm with you shortly. 🙏'
          );
        }
      }

      case 'cancel': {
        const order = orders.findDraft(m.chatId);
        if (!order) return false;
        orders.cancel(order);
        return reply(`Order ${order.id} cancelled. Message us anytime to start a new one.`);
      }

      default:
        return false; // stay silent on chit-chat
    }
  }

  // Requested lines -> portal availability -> draft order.
  async processOrderLines(m, requestedLines, reply, heading) {
    const resolved = await availability.resolve(requestedLines);
    store.upsertCustomer(m.from);

    // Log EVERY line, whatever the outcome — this is the sale-loss data.
    inquiries.recordMany(resolved, { customer: m.from, chatId: m.chatId });

    // A part the PORTAL DOES NOT KNOW goes to a human once, and the answer
    // is learned forever. A part it knows but has no stock of is NOT a human
    // question — the customer simply hears "on order, about 1 week".
    const unknown = resolved.filter((l) => l.source === 'unidentified');
    for (const u of unknown) {
      await escalation.create(this, {
        chatId: m.chatId,
        item: u.requested || u.item,
        qty: u.qty,
        kind: 'order',
      });
    }

    const usable = resolved.filter((l) => l.source !== 'unidentified');
    if (!usable.length) return true; // all escalated — the human flow answers

    const order = orders.getOrCreateDraft(m.chatId, m.from);
    orders.addLines(order, usable);

    let msg =
      `${heading || `Here is your current order (${order.id}):`}\n` +
      `${orders.summary(order)}\n\n` +
      `Reply with more items to add, "remove <item>", "<item> to <qty>" to change quantity, or *YES* to confirm.`;
    if (unknown.length) {
      msg += `\n\n⏳ Checking: ${unknown.map((u) => u.requested || u.item).join(', ')} — I'll confirm shortly.`;
    }
    return reply(msg);
  }

  // Availability question, no quantities yet.
  async answerInquiry(items, m) {
    const resolved = await availability.resolve(items.map((i) => ({ item: i, qty: 1 })));
    if (m) {
      inquiries.recordMany(resolved, { customer: m.from, chatId: m.chatId });
    }
    return `Stock check:\n${resolved.map((l) => availability.describe(l)).join('\n')}\n\nSend items with quantities to place an order.`;
  }

  // Live status. FOUNDER'S RULE: only TWO statuses ever reach a customer —
  // "packed and ready for dispatch" and "delivered". More than that and
  // "customer ko pagal ho jayega".
  orderStatus(m) {
    const mine = store.orders().filter(
      (o) => o.chatId === m.chatId || store.normPhone(o.customer) === m.from
    );
    const order = [...mine].reverse().find((o) => o.status !== 'cancelled');
    if (!order) return 'No recent order found for you. Send the items you need and I will get it started!';
    if (order.status === 'draft') {
      return `Your order ${order.id} is drafted and waiting for your *YES*:\n${orders.summary(order)}`;
    }
    if (order.status === 'delivered') {
      return `📦 Your order *${order.soNumber}* has been delivered. Thank you!`;
    }
    if (order.status === 'packed') {
      return `📦 Your order *${order.soNumber}* is packed and ready for dispatch.`;
    }
    return `Your order *${order.soNumber}* is being processed. I will update you as soon as it is packed and ready for dispatch.`;
  }

  // related items not already in the order (map editable in the console)
  crossSellFor(lines) {
    const map = store.load().crossSell || {};
    const suggestions = [];
    const has = (name) =>
      lines.some((l) => availability.sameItem(l.item, name)) ||
      suggestions.some((s) => availability.sameItem(s, name));
    for (const l of lines) {
      for (const [item, related] of Object.entries(map)) {
        if (!availability.sameItem(item, l.item)) continue;
        for (const r of related) if (!has(r)) suggestions.push(r);
      }
    }
    return suggestions.slice(0, 4);
  }

  // Credit Note issued for a customer -> share it on WhatsApp
  async shareCreditNote({ customerPhone, cnNumber, amount, reason }) {
    const cn = {
      id: 'CN-' + Date.now(),
      cnNumber: cnNumber || 'CN-' + store.nextSeq('order'),
      customerPhone: store.normPhone(customerPhone),
      amount,
      reason: reason || '',
      createdAt: new Date().toISOString(),
      sharedAt: null,
    };
    store.load().creditNotes.push(cn);
    await this.transport.sendText(
      cn.customerPhone,
      `📄 *Credit Note ${cn.cnNumber}* of Rs.${amount} has been issued to you` +
        (reason ? ` (${reason})` : '') +
        `. It has been adjusted in your ledger.`
    );
    cn.sharedAt = new Date().toISOString();
    store.save();
    store.log(this.key, `credit note ${cn.cnNumber} (Rs.${amount}) shared with ${cn.customerPhone}`);
    return cn;
  }

  // marketing broadcast to every known customer
  async broadcastOffer(text) {
    const targets = store.customers().map((c) => c.phone);
    for (const phone of targets) await this.transport.sendText(phone, text);
    store.load().offers.push({
      id: 'OFF-' + Date.now(),
      text,
      sentTo: targets.length,
      createdAt: new Date().toISOString(),
    });
    store.save();
    store.log(this.key, `offer broadcast sent to ${targets.length} customer(s)`);
    return targets.length;
  }
}

module.exports = CustomerBot;
