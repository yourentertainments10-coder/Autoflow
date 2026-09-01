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

  // chatId may be a 1:1 number or a group id — route accordingly.
  async sendToChat(chatId, text) {
    const id = String(chatId || '');
    const groups = require('../core/groups');
    if (/@g\.us/.test(id) || groups.findByGroupId(id)) {
      return this.sendToGroup(id, text);
    }
    return this.sendText(id.split('@')[0], text);
  }

  // ---- Groups -------------------------------------------------------------
  // Contract verified by probing the live API (see core/groups.js).
  async createGroup({ subject, participants, joinApprovalMode }) {
    if (!subject) throw new Error('group subject is required');
    const body = {
      messaging_product: 'whatsapp',
      subject: String(subject).slice(0, 100),
      join_approval_mode: joinApprovalMode || 'auto_approve',
    };
    const people = (participants || []).map((p) => store.normPhone(p)).filter(Boolean);
    if (people.length) body.participants = people.map((user) => ({ user }));

    const data = await this._post(`${config.cloud.phoneNumberId}/groups`, body);
    // be tolerant about where the id lands in the response
    const groupId =
      data.group_id || data.id || (data.groups && data.groups[0] && (data.groups[0].id || data.groups[0].group_id));
    if (!groupId) throw new Error('group created but no id in response: ' + JSON.stringify(data).slice(0, 200));
    store.log(this.botKey, `group created: "${subject}" -> ${groupId} (${people.length} participant(s) requested)`);
    return { groupId: String(groupId), inviteLink: data.invite_link || data.link || null, raw: data };
  }

  async listGroups() {
    const res = await fetch(`${GRAPH}/${config.cloud.phoneNumberId}/groups`, {
      headers: { Authorization: 'Bearer ' + config.cloud.token },
    });
    return res.json();
  }

  // send into a group; chatId here is the group id
  async sendToGroup(groupId, text) {
    await this._post(`${config.cloud.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'group',
      to: String(groupId).split('@')[0],
      type: 'text',
      text: { body: text, preview_url: false },
    });
    store.log(this.botKey, `send -> group ${groupId}: ${text.slice(0, 100).replace(/\n/g, ' | ')}`);
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
            // GROUP DETECTION. The exact field Meta uses for inbound group
            // messages is not documented in what we have, so check every
            // plausible location. When something looks group-ish but we
            // cannot place it, the raw payload is logged below so the real
            // shape can be read off a live message once.
            const groupId =
              msg.group_id ||
              (msg.group && (msg.group.id || msg.group.group_id)) ||
              (msg.context && msg.context.group_id) ||
              (value.metadata && value.metadata.group_id) ||
              null;
            const isGroup = Boolean(groupId);
            const m = {
              from: store.normPhone(msg.from),
              chatId: isGroup ? String(groupId) : store.normPhone(msg.from) + '@cloud',
              chatName: (msg.group && msg.group.subject) || '',
              isGroup,
              body: (msg.text && msg.text.body) || (msg.image && msg.image.caption) || '',
              hasMedia: Boolean(msg.image || msg.document),
              mediaType: msg.type,
            };
            // Learn the real payload shape: log anything carrying a hint of a
            // group that we did not manage to parse into a group id.
            if (!isGroup && /group/i.test(JSON.stringify(msg))) {
              store.log(this.botKey, 'UNRECOGNISED GROUP PAYLOAD (raw): ' + JSON.stringify(msg).slice(0, 700));
            }
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
