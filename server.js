// CEASER WEB PAIR RELAY
// This service never stores WhatsApp credentials. It queues short-lived pairing
// requests and accepts only signed, verified WebPay events.
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '64kb', verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const POLL_SECRET = process.env.WEBPAIR_SECRET || 'change-me';
const WEBPAY_SECRET = process.env.WEBPAY_WEBHOOK_SECRET || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
const OWNER_TG_ID = process.env.OWNER_TG_ID || process.env.ADMIN_TG_ID || '';
const TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || 'your_bot';
const DEV_TELEGRAM_USERNAME = process.env.DEV_TELEGRAM_USERNAME || 'your_username';
const JOB_TTL_MS = 5 * 60 * 1000;
const jobs = new Map();
const payments = new Map();

function cleanup() {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  for (const [id, p] of payments) if (now - p.createdAt > 90 * 24 * 60 * 60 * 1000) payments.delete(id);
}
setInterval(cleanup, 30000).unref?.();

function requireSecret(req, res, next) {
  if (!POLL_SECRET || req.get('x-poll-secret') !== POLL_SECRET) return res.status(401).json({ error: 'bad secret' });
  next();
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function verifyWebPay(req) {
  if (!WEBPAY_SECRET) return false;
  const supplied = req.get('x-webpay-signature') || req.get('x-webpay-secret');
  if (req.get('x-webpay-secret')) return safeEqual(supplied, WEBPAY_SECRET);
  const expected = crypto.createHmac('sha256', WEBPAY_SECRET).update(req.rawBody || Buffer.from(JSON.stringify(req.body || {}))).digest('hex');
  return safeEqual(supplied?.replace(/^sha256=/i, ''), expected);
}
function riskFor(body) {
  let score = 0;
  const sessions = Number(body.sessions ?? body.sessionCount ?? body.quantity ?? 0);
  const amount = Number(body.amount ?? body.total ?? 0);
  if (!body.paymentId && !body.id && !body.reference) score += 30;
  if (sessions > 3) score += Math.min(35, (sessions - 3) * 10);
  if (sessions > 10) score += 20;
  if (!Number.isFinite(amount) || amount <= 0) score += 20;
  if (body.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email))) score += 10;
  if (body.verified !== true && body.status !== 'paid' && body.status !== 'success') score += 25;
  score = Math.min(100, score);
  return { score, level: score >= 70 ? 'high' : score >= 35 ? 'medium' : 'low', sessions: Number.isFinite(sessions) ? sessions : 0 };
}
async function alertOwner(data) {
  if (!TELEGRAM_BOT_TOKEN || !OWNER_TG_ID || typeof fetch !== 'function') return;
  const text = `<b>💳 WEBPAY EVENT</b>\n<blockquote>🧾 Payment <code>${esc(data.paymentId)}</code>\n👤 Customer <code>${esc(data.customerId)}</code>\n📱 Sessions <b>${data.sessions}</b>\n🛡 Risk <b>${data.riskLevel}</b> (${data.riskScore}/100)\n✅ Verified <b>${data.verified ? 'yes' : 'no'}</b></blockquote>`;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER_TG_ID, text, parse_mode: 'HTML' })
    });
  } catch (e) { console.log('[webpay->owner]', e.message); }
}
function esc(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

app.get('/health', (_req, res) => res.json({ ok: true, service: 'ceaser-web-pair', jobs: jobs.size }));
app.post('/api/request-pair', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid number with country code, digits only.' });
  const id = crypto.randomBytes(12).toString('hex');
  jobs.set(id, { phone, status: 'pending', createdAt: Date.now() });
  res.json({ id, expiresIn: JOB_TTL_MS });
});
app.get('/api/job/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'expired, please try again' });
  res.json({ status: j.status, displayCode: j.displayCode || null, error: j.error || null, sessionName: j.sessionName || null });
});
app.get('/api/pending-jobs', requireSecret, (_req, res) => {
  const out = [];
  for (const [id, j] of jobs) if (j.status === 'pending') { j.status = 'sent'; j.sentAt = Date.now(); out.push({ id, phone: j.phone }); }
  res.json(out);
});
app.post('/api/job/:id/result', requireSecret, (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'job gone' });
  if (req.body.error) { j.status = 'error'; j.error = String(req.body.error).slice(0, 200); }
  else { j.status = 'done'; j.displayCode = String(req.body.displayCode || ''); j.sessionName = String(req.body.sessionName || ''); }
  j.updatedAt = Date.now();
  res.json({ ok: true });
});

// Provider-neutral WebPay webhook. Configure WEBPAY_WEBHOOK_SECRET and send
// either X-WebPay-Signature: sha256=<HMAC> or X-WebPay-Secret.
app.post('/api/webpay/webhook', (req, res) => {
  if (!verifyWebPay(req)) return res.status(401).json({ error: 'invalid webhook signature' });
  const paymentId = String(req.body.paymentId || req.body.id || req.body.reference || '').trim();
  if (!paymentId) return res.status(400).json({ error: 'payment id is required' });
  if (payments.has(paymentId)) return res.status(200).json({ ok: true, duplicate: true, payment: payments.get(paymentId) });
  const risk = riskFor(req.body);
  const verified = req.body.verified === true || ['paid', 'success', 'completed'].includes(String(req.body.status || '').toLowerCase());
  const record = { paymentId, customerId: String(req.body.customerId || req.body.customer || req.body.email || 'unknown'), sessions: risk.sessions, riskScore: risk.score, riskLevel: risk.level, verified, createdAt: Date.now() };
  payments.set(paymentId, record);
  alertOwner(record).catch(() => {});
  res.status(202).json({ ok: true, payment: record });
});
app.get('/api/config', (_req, res) => res.json({ telegramBot: TELEGRAM_BOT_USERNAME, devHandle: DEV_TELEGRAM_USERNAME }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Web pair server listening on ${PORT}`));
