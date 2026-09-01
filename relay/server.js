'use strict';
// Cartrends webhook relay — Render (free tier) par deploy hota hai.
// Meta ke WhatsApp webhooks receive karke memory-queue mein rakhta hai;
// AutoFlow (aapka PC) har kuch second /pull karke le jaata hai.
// Koi dependency nahi — pure Node http.
//
// Render env vars:
//   VERIFY_TOKEN  = cartrends-autoflow-verify-2026   (Meta handshake)
//   RELAY_SECRET  = koi lamba random string          (PC poll auth)
const http = require('http');

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'cartrends-autoflow-verify-2026';
const RELAY_SECRET = process.env.RELAY_SECRET || 'change-me';
const PORT = process.env.PORT || 10000;

const queue = []; // {ts, body}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // Meta webhook verification handshake
  if (req.method === 'GET' && url.pathname === '/webhook/wa') {
    if (url.searchParams.get('hub.mode') === 'subscribe' &&
        url.searchParams.get('hub.verify_token') === VERIFY_TOKEN) {
      res.writeHead(200);
      return res.end(url.searchParams.get('hub.challenge') || '');
    }
    res.writeHead(403);
    return res.end();
  }

  // Meta webhook events -> queue
  if (req.method === 'POST' && url.pathname === '/webhook/wa') {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        queue.push({ ts: Date.now(), body: JSON.parse(data) });
        if (queue.length > 500) queue.splice(0, queue.length - 500);
      } catch {}
      res.writeHead(200);
      res.end('OK');
    });
    return;
  }

  // AutoFlow poll -> queue drain
  if (req.method === 'GET' && url.pathname === '/pull') {
    if (url.searchParams.get('secret') !== RELAY_SECRET) {
      res.writeHead(403);
      return res.end();
    }
    const out = queue.splice(0, queue.length);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(out));
  }

  // health
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('cartrends-relay ok | queued: ' + queue.length);
});

server.listen(PORT, () => console.log('relay listening on', PORT));
