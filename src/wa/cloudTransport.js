'use strict';
// Official WhatsApp Cloud API transport (Meta Graph API).
// Same surface as the linked-device transports:
//   start(), sendText(number, text), sendToChat(chatId, text),
//   onMessage(handler), status()
// Receiving needs the webhook route (console/server.js mounts
// GET+POST /webhook/wa) reachable on a PUBLIC https URL — Meta se
// configure hota hai. Sending works standalone (24h service window
// ya approved template ke andar).
const config = require('../config');
const store = require('../store');

const GRAPH = 'https://graph.facebook.com/v23.0';

class CloudTransport {
  constructor(botKey, label) {
    this.botKey = botKey;
    this.label = label;
    this.number = config.bots[botKey].number;
    this.mode = 'CLOUD';
    this.state = 'send-ready (webhook pending)';
    this.handlers = [];
    this.roles = [botKey];
    this.qrDataUrl = null; // QR hota hi nahi is transport mein
  }

  async start() {
    if (this._started) return;
    this._started = true;
    store.log(this.botKey, `${this.label} on OFFICIAL Cloud API (${this.number}) — sending live; receiving needs webhook`);
  }

  onMessage(fn) {
    this.handlers.push(fn);
  }

  async _post(path, body) {
    const res = await fetch(`${GRAPH}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.cloud.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (data.error && (data.error.message + (data.error.error_data ? ' | ' + JSON.stringify(data.error.error_data) : ''))) || 'HTTP ' + res.status;
      throw new Error('CloudAPI: ' + err);
    }
    return data;
  }

  async sendText(number, text) {
    const to = store.normPhone(number);
    await this._post(`${config.cloud.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text, preview_url: false },
    });
    store.log(this.botKey, `send -> ${to} [cloud]: ${text.slice(0, 120).replace(/\n/g, ' | ')}`);
  }

  async sendToChat(chatId, text) {
    return this.sendText(String(chatId).split('@')[0], text);
  }

  // template send — business-initiated messages (24h window ke bahar) ke liye
  async sendTemplate(number, templateName, langCode, components) {
    const to = store.normPhone(number);
    await this._post(`${config.cloud.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: langCode || 'en' }, ...(components ? { components } : {}) },
    });
    store.log(this.botKey, `send -> ${to} [cloud template:${templateName}]`);
  }

  // media id -> base64 (photo orders ke liye)
  async _downloadMedia(mediaId) {
    const meta = await fetch(`${GRAPH}/${mediaId}`, {
      headers: { Authorization: 'Bearer ' + config.cloud.token },
    }).then((r) => r.json());
    if (!meta.url) return null;
    const bin = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + config.cloud.token } });
    if (!bin.ok) return null;
    const buf = Buffer.from(await bin.arrayBuffer());
    return { base64: buf.toString('base64'), mime: meta.mime_type || 'image/jpeg' };
  }

  // Meta webhook POST body -> dispatch to bot handlers
  async handleWebhook(body) {
    this.state = 'connected (webhook live)';
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        // Meta sends more than inbound messages here (delivery statuses,
        // errors, template updates). Log what actually arrived — silently
        // dropping them makes "webhook fired but nothing happened"
        // impossible to debug.
        const pnid = value.metadata && value.metadata.phone_number_id;
        const kinds = Object.keys(value).filter((k) => k !== 'messaging_product' && k !== 'metadata');
        if (!value.messages) {
          const detail = (value.statuses || [])
            .map((s) => `${s.status}${s.recipient_id ? ' -> ' + s.recipient_id : ''}`)
            .join(', ');
          const errs = (value.errors || []).map((e) => e.title || e.message).join('; ');
          store.log(
            this.botKey,
            `webhook [${change.field}] pn=${pnid || '?'} keys=${kinds.join('+') || 'none'}` +
              (detail ? ` :: ${detail}` : '') +
              (errs ? ` :: ERROR ${errs}` : '')
          );
        }
        // sirf APNE number ke events process karo — shared WABA par doosre
        // numbers (e.g. 414/ProcureHub) ke events bhi aa sakte hain
        if (pnid && pnid !== config.cloud.phoneNumberId) {
          store.log(this.botKey, `webhook ignored: for phone_number_id ${pnid}, not ours (${config.cloud.phoneNumberId})`);
          continue;
        }
        for (const msg of value.messages || []) {
          try {
            const m = {
              from: store.normPhone(msg.from),
              chatId: store.normPhone(msg.from) + '@cloud',
              chatName: '',
              isGroup: false, // groups Cloud API par OBA ke baad aayenge
              body: (msg.text && msg.text.body) || (msg.image && msg.image.caption) || '',
              hasMedia: Boolean(msg.image || msg.document),
              mediaType: msg.type,
            };
            if (msg.image && msg.image.id) {
              const media = await this._downloadMedia(msg.image.id);
              if (media && /^image\//.test(media.mime)) {
                m.mediaBase64 = media.base64;
                m.mediaMime = media.mime;
              }
            }
            store.log(this.botKey, `recv <- ${m.from} [cloud]: ${(m.body || '(' + m.mediaType + ')').slice(0, 100).replace(/\n/g, ' | ')}`);
            for (const fn of this.handlers) {
              if ((await fn(m)) === true) break;
            }
          } catch (e) {
            store.log(this.botKey, 'cloud webhook handler error: ' + String((e && e.message) || e).slice(0, 200));
          }
        }
      }
    }
  }

  status() {
    return { mode: this.mode, state: this.state, qrDataUrl: null, roles: this.roles };
  }
}

module.exports = { CloudTransport };
