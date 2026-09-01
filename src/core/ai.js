'use strict';
// Message understanding.
// Deterministic parsers work out of the box; if ANTHROPIC_API_KEY is set,
// Claude is used first (handles Hinglish, free-form sentences, messy lists)
// and the deterministic parser remains the fallback.
const config = require('../config');
const store = require('../store');

// ---------------- deterministic parsers ----------------

// Real customer formats (group screenshots se):
//   "55810m75J30 2 pcs" · "26300_02752 40 pcs" · "Ecstar 0w20 engine oil 3 Box"
//   "16510m68k10.48 pcs" (qty part se chipki hui) · "Brake Pad - 10 - 450"
//   "10 x Brake Pad" · "Brake Pad qty 10 @450"
const UNITS = '(?:pcs?|nos?\\.?|box(?:es)?|sets?|pkts?|packets?|ltrs?|litres?|qty)';
function parseLine(line) {
  const t = line.replace(/[–—]/g, '-').trim();
  if (!t || t.length < 2) return null;

  // qty-first: "10 x Brake Pad", "2 pcs 55810m75J30"
  let m = t.match(new RegExp(`^(\\d+)\\s*(?:x|${UNITS})?\\s+(.+?)(?:\\s*[-@]\\s*(?:rs\\.?\\s*)?(\\d+(?:\\.\\d+)?))?$`, 'i'));
  if (m && m[2] && !/^[\d\s:-]+$/.test(m[2])) {
    return { item: clean(m[2]), qty: parseInt(m[1], 10), price: m[3] ? parseFloat(m[3]) : null };
  }
  // qty-last with an "x" separator: "Spark Plug x 4", "Plug x4". The x must
  // be its OWN token (whitespace before it) so "Filter Max 4" ki item name
  // se 'x' kabhi nahi katta.
  m = t.match(/^(.+?)\s+[x×]\s*(\d+)\s*(?:[-@]\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?))?$/i);
  if (m && m[1].length >= 3 && !/^[\d\s._-]+$/.test(m[1])) {
    return { item: clean(m[1]), qty: parseInt(m[2], 10), price: m[3] ? parseFloat(m[3]) : null };
  }
  // "PART.48 pcs" — qty dot se part number mein chipki hai, unit word zaroori
  m = t.match(new RegExp(`^(.+?)\\.\\s*(\\d+)\\s*${UNITS}\\s*$`, 'i'));
  if (m && m[1].length >= 4) {
    return { item: clean(m[1]), qty: parseInt(m[2], 10), price: null };
  }
  m = t.match(new RegExp(`^(.+?)\\s*[-:]\\s*(\\d+)\\s*(?:${UNITS}\\s*)?(?:[-@]\\s*(?:rs\\.?\\s*)?(\\d+(?:\\.\\d+)?))?$`, 'i'));
  if (m) {
    return { item: clean(m[1]), qty: parseInt(m[2], 10), price: m[3] ? parseFloat(m[3]) : null };
  }
  // unit word PRESENT -> item kuch bhi ho sakta hai (digit-start part numbers samet)
  m = t.match(new RegExp(`^(.+?)\\s+(\\d+)\\s*${UNITS}\\s*(?:[-@]\\s*(?:rs\\.?\\s*)?(\\d+(?:\\.\\d+)?))?$`, 'i'));
  if (m && m[1].length >= 3) {
    return { item: clean(m[1]), qty: parseInt(m[2], 10), price: m[3] ? parseFloat(m[3]) : null };
  }
  // unit word ABSENT -> item pure digits nahi hona chahiye ("20 250" jaisi lines skip)
  m = t.match(/^(.+?)\s+(\d+)\s*(?:[-@]\s*(?:rs\.?\s*)?(\d+(?:\.\d+)?))?$/i);
  if (m && m[1].length >= 3 && !/^[\d\s._-]+$/.test(m[1])) {
    return { item: clean(m[1]), qty: parseInt(m[2], 10), price: m[3] ? parseFloat(m[3]) : null };
  }
  return null;
}
function clean(s) {
  return s.replace(/\s+/g, ' ').replace(/^["'*\-\s]+|["'*\-\s]+$/g, '').trim();
}

function parseLinesBlock(text) {
  const out = [];
  for (const line of String(text || '').split(/\n/)) {
    const p = parseLine(line);
    // qty cap: a "quantity" like 7703083335 is really a part number
    if (p && p.qty > 0 && p.qty <= 99999 && p.item) out.push(p);
  }
  return out;
}

const CONFIRM_RE = /^(yes|yess*|confirm(ed)?|ok(ay)?|done|haan+|ha|thik hai|theek hai|pakka|final|confirm karo|book it|place (the )?order)\b/i;
const CANCEL_RE = /^(no|cancel|cancel (the )?order|rehne do|mat karo|stop)\b/i;
const STATUS_RE = /\b(status|track(ing)?|kaha+n?\s*(hai|tak|pahuncha|pahunchi|pohcha)|where('?s| is)?\s*(my|the)?\s*(order|delivery|goods|maal|gadi)|order (kahan|kidhar|kab)|gadi (kahan|kidhar)|deliver(y|ed)?\s*(kab|when)|kab (tak )?(aayega|milega|pahunchega))\b/i;
const REMOVE_RE = /^(remove|delete|hata(o| do)?)\s+(.+)$/i;
const SET_QTY_RE = /^(?:make|set|change)?\s*(.+?)\s+(?:to|=|ko)\s*(\d+)$/i;

// intent for a customer message given the known catalog item names
function parseCustomerMessageBasic(text, catalogNames) {
  const t = String(text || '').trim();
  if (!t) return { intent: 'other' };
  if (CONFIRM_RE.test(t)) return { intent: 'confirm' };
  if (CANCEL_RE.test(t)) return { intent: 'cancel' };
  if (STATUS_RE.test(t)) return { intent: 'status' };

  let m = t.match(REMOVE_RE);
  if (m) return { intent: 'remove', item: clean(m[3]) };
  // "Brake Pad to 8" -- a quantity change. Do NOT gate this on a catalog:
  // the catalog is the Dealer Portal now and is not available here. The bot
  // falls back to treating it as a new order line if the draft has no such
  // item (see customerBot's set_qty case).
  m = t.match(SET_QTY_RE);
  if (m && m[1].trim().length >= 3 && !/^[\d\s._-]+$/.test(m[1])) {
    return { intent: 'set_qty', item: clean(m[1]), qty: parseInt(m[2], 10) };
  }

  const lines = parseLinesBlock(t);
  if (lines.length) return { intent: 'order', lines };

  // part-number inquiry: "17521M68PA0 avl?", "7703083335 available?", "Part
  // No ARVM001623 LR h" — the bot ALWAYS answers (found or "not available").
  // Mixed letter+digit tokens are always parts; pure-digit tokens count as
  // parts only alongside inquiry words (so phone numbers in chit-chat don't).
  const mixedTokens = t.match(/\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{5,}\b/g) || [];
  const inquiryish = /price|rate|stock|avl|available|availability|kitna|hai kya|milega|need|want|chahiye|required?|requirement|lena hai|part\s*no/i.test(t);
  const digitTokens = inquiryish ? t.match(/\b\d{6,15}\b/g) || [] : [];
  const partTokens = [...mixedTokens, ...digitTokens]
    .map((x) => x.replace(/-(avl|aval|avail|qty|pcs?|nos?)$/i, '')) // "17521M68PA0-avl" -> part only
    .filter((x) => x.length >= 6 && !/^(whatsapp|cartrends)/i.test(x));
  if (partTokens.length) return { intent: 'inquiry', items: [...new Set(partTokens)] };

  // inquiry: mentions availability/price/need + a catalog item
  // ("Hello I need some brake pad" — no qty yet, so ask/quote first)
  if (/price|rate|stock|available|availability|kitna|hai kya|milega|need|want|chahiye|required?|requirement|lena hai/i.test(t)) {
    const hits = catalogNames.filter((n) => t.toLowerCase().includes(n.toLowerCase()));
    if (hits.length) return { intent: 'inquiry', items: hits };
    // No local catalog match -- strip the question words and let the Dealer
    // Portal decide. The portal IS the catalog; asking a human comes only
    // after the portal says it does not know the part.
    const phrase = t
      .replace(/\bpart\s*(no|number)\b/gi, ' ')
      .replace(
        /\b(price|rate|stock|available|availability|avl|aval|kitna|kya|hai|ka|ki|ke|what|is|the|of|for|mein|me|milega|aur|and|do|please|bhai|sir|need|want|chahiye|required|requirement|lena)\b/gi,
        ' '
      )
      .replace(/[?.!,]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { intent: 'inquiry', items: phrase.length >= 3 ? [phrase] : [] };
  }
  // single free-form order like "need 5 brake pads"
  const one = t.match(/(?:need|want|chahiye|send|bhejo|order)\s+(\d+)\s+(.+)/i);
  if (one) return { intent: 'order', lines: [{ item: clean(one[2]), qty: parseInt(one[1], 10), price: null }] };
  return { intent: 'other' };
}

function matchCatalog(name, catalogNames) {
  const n = String(name || '').toLowerCase().trim();
  return catalogNames.find((c) => c.toLowerCase() === n || c.toLowerCase().includes(n) || n.includes(c.toLowerCase())) || null;
}

// ---------------- Claude-backed parsing ----------------

// user may be a plain string or a content-block array (for images)
async function claude(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.ai.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ai.model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error('Anthropic API HTTP ' + res.status);
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || '').join('');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('no JSON in AI reply');
  return JSON.parse(jsonMatch[0]);
}

async function parseCustomerMessage(text, catalogNames) {
  if (config.ai.apiKey) {
    try {
      const r = await claude(
        'You parse WhatsApp messages from auto-parts customers (English/Hindi/Hinglish). ' +
          'Reply ONLY with JSON: {"intent":"order|inquiry|confirm|cancel|remove|set_qty|status|other",' +
          '"lines":[{"item":str,"qty":int}],"items":[str],"item":str,"qty":int}. ' +
          'Use "confirm" only for a clear final yes. Known catalog items: ' +
          catalogNames.slice(0, 200).join(', '),
        text
      );
      if (r && r.intent) return r;
    } catch (e) {
      store.log('ai', 'Claude parse failed, using basic parser: ' + e.message);
    }
  }
  return parseCustomerMessageBasic(text, catalogNames);
}

async function parseVendorStock(text) {
  const basic = parseLinesBlock(text);
  if (basic.length) return basic;
  if (config.ai.apiKey) {
    try {
      const r = await claude(
        'You parse WhatsApp stock lists from auto-parts vendors (any format/language). ' +
          'Reply ONLY with JSON: {"lines":[{"item":str,"qty":int,"price":number|null}]}. ' +
          'If the message is not a stock list, reply {"lines":[]}.',
        text
      );
      if (r && Array.isArray(r.lines)) return r.lines.filter((l) => l.item && l.qty > 0);
    } catch (e) {
      store.log('ai', 'Claude stock parse failed: ' + e.message);
    }
  }
  return [];
}

// ---------------- photo orders (OCR chain) ----------------
// "Customer photograph mein order bheje" — read it with, in order:
//   1. Python OCR libraries  (scripts/ocr/read_order.py: pytesseract/easyocr)
//   2. Windows built-in OCR  (scripts/ocr/windows_ocr.ps1 — zero install)
//   3. Claude vision         (only if ANTHROPIC_API_KEY is set)
// OCR text is parsed with the deterministic line parser; if that finds
// nothing and an AI key exists, Claude cleans up the raw OCR text.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OCR_DIR = path.join(__dirname, '..', '..', 'scripts', 'ocr');

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs || 60000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

async function ocrImageToText(base64, mediaType) {
  const ext = (mediaType || 'image/png').split('/')[1].replace('jpeg', 'jpg');
  const tmp = path.join(os.tmpdir(), 'autoflow-ocr-' + Date.now() + '.' + ext);
  fs.writeFileSync(tmp, Buffer.from(base64, 'base64'));
  try {
    let text = await run('python', [path.join(OCR_DIR, 'read_order.py'), tmp]);
    if (text && text.trim()) return text;
    if (process.platform === 'win32') {
      text = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(OCR_DIR, 'windows_ocr.ps1'), '-Path', tmp]);
      if (text && text.trim()) return text;
    }
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Sanity filter for photo-derived lines: an invoice/bill photo must never
// become an order ("Invoice - 2939" parsing as item "Invoice" x 2939).
const NON_ITEM_RE = /^(invoice|bill|total|subtotal|amount|gst|sgst|cgst|igst|hsn|challan|date|no|number|qty|quantity|rate|price|order|item|sr|s\.?no)\b/i;
function sanitizeOrderLines(lines, rawText) {
  // if the text looks like a tax invoice, refuse the whole thing
  if (rawText && /(gst\s*invoice|tax\s*invoice|invoice\s*(no|number|#|-)\s*\d+|hsn|igst|cgst|sgst)/i.test(rawText)) return [];
  return (lines || []).filter(
    (l) => l.item && l.item.length >= 3 && !NON_ITEM_RE.test(l.item.trim()) && l.qty > 0 && l.qty <= 500
  );
}

// Returns: lines[] on success, [] if nothing readable, null only when no
// OCR backend produced text AND no AI key exists (caller apologises politely).
async function parseOrderImage(base64, mediaType) {
  const ocrText = await ocrImageToText(base64, mediaType);
  if (ocrText) {
    const lines = sanitizeOrderLines(parseLinesBlock(ocrText), ocrText);
    if (lines.length) {
      store.log('ai', `photo order read via OCR: ${lines.length} line(s)`);
      return lines;
    }
    if (config.ai.apiKey) {
      try {
        const r = await claude(
          'This is raw OCR text from a photo of an auto-parts order (may be messy/Hinglish). ' +
            'Reply ONLY with JSON: {"lines":[{"item":str,"qty":int}]}. If it is not an order, reply {"lines":[]}.',
          ocrText
        );
        if (r && Array.isArray(r.lines)) return sanitizeOrderLines(r.lines, ocrText);
      } catch (e) {
        store.log('ai', 'OCR-text cleanup failed: ' + e.message);
      }
    }
    return []; // OCR saw text but no order lines in it
  }
  // no OCR text at all — try Claude vision if available
  if (config.ai.apiKey) {
    try {
      const r = await claude(
        'You read photos of handwritten or printed auto-parts order lists sent by customers on WhatsApp ' +
          '(English/Hindi/Hinglish, any layout). Reply ONLY with JSON: {"lines":[{"item":str,"qty":int}]}. ' +
          'If the image contains no order, reply {"lines":[]}.',
        [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } },
          { type: 'text', text: 'Extract the order lines from this image.' },
        ]
      );
      if (r && Array.isArray(r.lines)) return sanitizeOrderLines(r.lines, null);
    } catch (e) {
      store.log('ai', 'image order parse failed: ' + e.message);
    }
    return [];
  }
  return null;
}

module.exports = { parseCustomerMessage, parseVendorStock, parseOrderImage, parseLinesBlock, matchCatalog, CONFIRM_RE };
