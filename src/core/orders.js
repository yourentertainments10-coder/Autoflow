'use strict';
// Sales Order lifecycle.
//   draft (held locally) -> customer modifies freely -> final "yes"
//   -> punched into the Dealer Portal via its confirm API -> done.
//
// There is no order split any more. The Dealer Portal owns everything after
// the punch: PO to the vendor, warehouse, transit, invoicing. This process
// only captures the order and reports status back to the customer.
const store = require('../store');
const availability = require('./availability');
const portal = require('../integrations/dealerPortal');
const inquiries = require('./inquiries');

function findDraft(chatId) {
  return store.orders().find((o) => o.chatId === chatId && o.status === 'draft') || null;
}

function getOrCreateDraft(chatId, customer) {
  let o = findDraft(chatId);
  if (!o) {
    o = {
      id: 'ORD-' + store.nextSeq('order'),
      chatId,
      customer: customer || chatId,
      lines: [], // resolved lines from availability.resolve()
      status: 'draft',
      soNumber: null,
      createdAt: new Date().toISOString(),
    };
    store.orders().push(o);
    store.save();
  }
  return o;
}

// Merge already-resolved lines into the draft. Re-asks the portal when a
// quantity changes, so availability always reflects the CURRENT quantity.
function addLines(order, resolvedLines) {
  for (const line of resolvedLines) {
    const existing = order.lines.find((l) => availability.sameItem(l.item, line.item));
    if (existing) {
      existing.qty += line.qty;
      existing.partial = existing.available > 0 && existing.available < existing.qty;
    } else {
      order.lines.push(line);
    }
  }
  store.save();
  return order;
}

async function setQty(order, item, qty) {
  const line = order.lines.find((l) => availability.sameItem(l.item, item));
  if (!line) return false;
  if (qty <= 0) {
    order.lines = order.lines.filter((l) => l !== line);
    store.save();
    return true;
  }
  const fresh = await availability.resolveOne(line.partNo || line.item, qty);
  Object.assign(line, fresh, { requested: line.requested || line.item });
  store.save();
  return true;
}

function removeItem(order, item) {
  const before = order.lines.length;
  order.lines = order.lines.filter((l) => !availability.sameItem(l.item, item));
  store.save();
  return order.lines.length < before;
}

function cancel(order) {
  order.status = 'cancelled';
  store.save();
}

function summary(order) {
  if (!order.lines.length) return 'Cart is empty.';
  return order.lines
    .map((l, i) => {
      const name = l.requested || l.item;
      const price = l.price ? ` @ Rs.${l.price}` : '';
      const state =
        l.source === 'unavailable'
          ? 'on order, ~1 week'
          : l.source === 'unknown' || l.source === 'unidentified'
            ? 'checking'
            : l.partial
              ? `only ${l.available} now, rest on order`
              : 'available';
      return `${i + 1}. ${name} x ${l.qty}${price} — ${state}`;
    })
    .join('\n');
}

// Final confirmation: punch the SO into the Dealer Portal.
// A line the customer confirmed while it was NOT available is still sent —
// the founder's rule is "confirm karo to aapke liye rok deta hun" (reserve
// it), so an out-of-stock line becomes a back-order, not a silent drop.
async function confirm(order) {
  if (!order.lines.length) throw new Error('nothing to confirm');

  const { soNumber } = await portal.confirm(order);
  order.soNumber = soNumber;
  order.status = 'confirmed';
  order.confirmedAt = new Date().toISOString();
  store.save();

  const backordered = order.lines.filter((l) => l.source === 'unavailable' || l.partial);
  store.log(
    'orders',
    `${order.id} confirmed -> ${soNumber} (${order.lines.length} line(s), ${backordered.length} back-ordered)`
  );
  return { soNumber, backordered };
}

module.exports = { findDraft, getOrCreateDraft, addLines, setQty, removeItem, cancel, summary, confirm };
