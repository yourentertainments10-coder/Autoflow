'use strict';
// Availability resolution. Replaces the old local-stock module: this process
// holds NO stock. Every answer comes from the Dealer Portal `analyze` call.
//
// Before asking the portal, each requested line passes through the learned
// alias map (core/knowledge.js) so a loose customer phrase — "clutch plate
// swift dzire petrol" — becomes the real part number a human taught us once.
const portal = require('../integrations/dealerPortal');
const knowledge = require('./knowledge');
const store = require('../store');

// Part numbers compare on letters+digits only (ProcureHub and the Dealer
// Portal both normalise this way): "DM-BP/1001" === "DMBP1001".
function normPart(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

// Loose name comparison for cart operations ("remove oil filter").
function sameItem(a, b) {
  const x = String(a == null ? '' : a).toLowerCase().trim();
  const y = String(b == null ? '' : b).toLowerCase().trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (normPart(x) && normPart(x) === normPart(y)) return true;
  return x.includes(y) || y.includes(x);
}

// A token that looks like a part number rather than a product name.
function looksLikePartNumber(text) {
  const t = String(text || '').trim();
  if (t.length < 5) return false;
  return /\d/.test(t) && /^[A-Za-z0-9\-_./ ]+$/.test(t) && !/\s{2,}/.test(t);
}

// Names we can offer the message parser for matching. Sourced from what we
// have actually learned, not from a local stock table (there isn't one).
function catalogNames() {
  return knowledge.aliasNames();
}

// Ask the Dealer Portal about a batch of requested lines.
// lines: [{ item, qty }]  ->  resolved lines (see dealerPortal.normaliseLine)
async function resolve(lines) {
  const prepared = (lines || []).map((l) => {
    const alias = knowledge.lookupAlias(l.item);
    return {
      item: l.item,
      // alias wins; otherwise a part-number-looking phrase is sent as-is
      partNo: alias || (looksLikePartNumber(l.item) ? l.item : null),
      qty: Number(l.qty) || 1,
      _aliased: Boolean(alias),
    };
  });

  const resolved = await portal.analyze(prepared);

  // Keep the customer's own wording in replies — they recognise what they
  // typed, not our internal part name.
  return resolved.map((r, i) => ({
    ...r,
    requested: prepared[i].item,
    item: r.item || prepared[i].item,
  }));
}

// Convenience for a single line.
async function resolveOne(item, qty) {
  const [line] = await resolve([{ item, qty: qty || 1 }]);
  return line;
}

// Human-readable availability line for a quote.
function describe(line) {
  if (line.source === 'unknown') return `• ${line.requested || line.item}: checking, I will confirm shortly`;
  if (line.source === 'unidentified') return `• ${line.requested || line.item}: confirming the exact part — I will get back to you`;
  if (line.source === 'unavailable') {
    // Founder's exact phrasing for a not-in-stock item.
    return `• ${line.requested || line.item}: not in stock right now — it is on order, about 1 week. Confirm and I will reserve it for you`;
  }
  const price = line.price ? ` (Rs.${line.price})` : '';
  if (line.partial) {
    return `• ${line.requested || line.item}: only ${line.available} available now${price}, the rest on order (about 1 week)`;
  }
  return `• ${line.requested || line.item}: available${price} — ${line.eta}`;
}

module.exports = {
  resolve,
  resolveOne,
  describe,
  sameItem,
  normPart,
  looksLikePartNumber,
  catalogNames,
};
