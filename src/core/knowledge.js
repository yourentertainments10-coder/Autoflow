'use strict';
// Permanent knowledge — the founder's "knowledge shift" requirement:
//
//   "vo kahega bhaiya mujhe samjhao ... aur hamesha ke liye vo knowledge mein
//    store ho jana chahiye, taki agli baar usse koi same sawal poochhe to
//    vapas mujhse na poochhe."
//
// Two kinds of learning, both persisted in data/state.json:
//
//   aliases — a customer phrase -> the real part number. Written every time
//             a human resolves an escalation, and every time the portal
//             answers a phrase we had not seen before. Consulted BEFORE the
//             portal on the next message, so the same question is never
//             escalated twice.
//   notes   — free-form things a human taught us (fitment, replaceability)
//             that are not a simple phrase->part mapping.
const store = require('../store');

function key(phrase) {
  return String(phrase || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function bank() {
  const s = store.load();
  if (!s.knowledge) s.knowledge = { aliases: {}, notes: [] };
  if (!s.knowledge.aliases) s.knowledge.aliases = {};
  if (!s.knowledge.notes) s.knowledge.notes = [];
  return s.knowledge;
}

// phrase -> part number, or null. Exact key first, then a contained-phrase
// match so "5 clutch plate swift" still finds "clutch plate swift".
function lookupAlias(phrase) {
  const k = key(phrase);
  if (!k) return null;
  const aliases = bank().aliases;
  if (aliases[k]) return aliases[k].partNo;
  for (const [alias, entry] of Object.entries(aliases)) {
    if (alias.length >= 4 && (k.includes(alias) || alias.includes(k))) return entry.partNo;
  }
  return null;
}

// Teach a phrase -> part number. `source` records who taught it.
function learnAlias(phrase, partNo, source) {
  const k = key(phrase);
  if (!k || !partNo) return null;
  const aliases = bank().aliases;
  const existing = aliases[k];
  aliases[k] = {
    partNo: String(partNo),
    source: source || 'human',
    learnedAt: existing ? existing.learnedAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    hits: existing ? existing.hits || 0 : 0,
  };
  store.save();
  store.log('knowledge', `learned: "${k}" -> ${partNo} (${source || 'human'})`);
  return aliases[k];
}

function noteAliasHit(phrase) {
  const k = key(phrase);
  const entry = bank().aliases[k];
  if (entry) {
    entry.hits = (entry.hits || 0) + 1;
    entry.lastUsedAt = new Date().toISOString();
    store.save();
  }
}

// Every learned phrase — offered to the message parser as its catalog.
function aliasNames() {
  return Object.keys(bank().aliases);
}

function addNote(question, answer, source) {
  const note = {
    id: 'KN-' + Date.now(),
    question: String(question || '').trim(),
    answer: String(answer || '').trim(),
    source: source || 'human',
    createdAt: new Date().toISOString(),
  };
  bank().notes.push(note);
  store.save();
  store.log('knowledge', `note saved: "${note.question.slice(0, 60)}"`);
  return note;
}

// Best-effort recall of a previously answered question.
function findNote(question) {
  const k = key(question);
  if (k.length < 4) return null;
  return (
    bank().notes.find((n) => {
      const nk = key(n.question);
      return nk && (nk === k || nk.includes(k) || k.includes(nk));
    }) || null
  );
}

function all() {
  const b = bank();
  return { aliases: b.aliases, notes: b.notes };
}

module.exports = { lookupAlias, learnAlias, noteAliasHit, aliasNames, addNote, findNote, all };
