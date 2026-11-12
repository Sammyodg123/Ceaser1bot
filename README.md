# CEASER MD

CEASER MD is a WhatsApp automation bot for accounts that the user owns or is authorized to manage. It provides approved commands, group tools, media utilities, and status workflows after a device is paired.

## What was fixed

- **Session stability:** credential writes are serialized, valid credential backups are preserved, the connection watchdog is less aggressive, and transient `401`/connection-replacement events no longer delete or rename linked session folders.
- **Command conflict protection:** the WhatsApp runtime uses one command registry/dispatcher. Long-running status and cast operations (`gstatus`, `gstatusall`, `gcast`, `gcastall`, `gcasttext`, and `broadcast`) are isolated per session and are rejected while the same operation is already running instead of colliding or blocking every message.
- **Web pairing:** `webpoller.js` securely polls the public relay outbound, returns pairing results, and reports website pair/code/link events to the Telegram owner alert hook.
- **Owner alerts:** Telegram receives alerts when a pairing code is created and when the WhatsApp session finishes linking.
- **WebPay:** the web relay includes a provider-neutral signed webhook at `POST /api/webpay/webhook`. It deduplicates payment IDs, validates the signature, calculates a transparent risk score from verification status, amount, customer identity, and requested session count, and alerts the Telegram owner.
- **Website copy:** the pairing page now clearly explains that this is an automation bot for the user's own WhatsApp account and must not be used to access another person's account.

## Architecture

Run `server.js` on the public web host. It stores only short-lived pairing jobs and payment event summaries. Run `index.js` and `Telegram.js` on the WhatsApp/Pterodactyl host with the auth/session directory on persistent storage. The bot host polls the web relay; the relay does not need inbound access to the WhatsApp process.

## Important environment variables

### Web relay

```text
WEBPAIR_SECRET=long-random-secret
WEBPAY_WEBHOOK_SECRET=another-long-random-secret
TELEGRAM_BOT_TOKEN=123:abc
OWNER_TG_ID=123456789
TELEGRAM_BOT_USERNAME=your_bot_username
DEV_TELEGRAM_USERNAME=your_username
PORT=3000
```

### WhatsApp host

```text
WEBPAIR_URL=https://your-web-relay.example.com
WEBPAIR_SECRET=the-same-long-random-secret
WEBPAIR_POLL_MS=4000
BOT_TOKEN=your-telegram-bot-token
OWNER_TG_ID=your-telegram-owner-id
SESSIONS_DIR=/persistent/path/sessions
```

Keep `SESSIONS_DIR` on a persistent disk. Do not commit it, send it through Telegram, or expose it through the website: it contains WhatsApp login credentials.

## WebPay webhook

Send a signed JSON request to `/api/webpay/webhook` using either:

- `X-WebPay-Signature: sha256=<hex HMAC-SHA256>` with `WEBPAY_WEBHOOK_SECRET`, or
- `X-WebPay-Secret: <WEBPAY_WEBHOOK_SECRET>` for providers that cannot produce HMAC signatures.

Example payload:

```json
{
  "paymentId": "pay_123",
  "customerId": "telegram-123456",
  "status": "paid",
  "verified": true,
  "amount": 100,
  "sessions": 2
}
```

The webhook is intentionally provider-neutral because the original archive did not contain a WebPay SDK or provider-specific checkout configuration. Connect your provider's verified webhook to this endpoint; do not treat a browser redirect alone as proof of payment.

## Checks

Run:

```bash
npm install
npm run check
npm start
```

The original WhatsApp runtime also expects its Baileys/media dependencies from the bot deployment. Install the same runtime dependency set used by your existing Pterodactyl image before running `npm run start:bot`.
