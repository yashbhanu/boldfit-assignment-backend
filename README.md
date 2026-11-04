# Boldfit Checkout – Backend

NestJS + TypeScript + MongoDB (Mongoose). Razorpay test mode for payments.

Part of a take-home assignment: catalog → cart → order → Razorpay payment → webhook confirms the order. The frontend lives in a separate repo.

## Run locally

Needs Node 20+, MongoDB and Razorpay **test** keys.

```bash
npm install
npm run start:dev      # http://localhost:3000
```

| Variable | Value |
|---|---|
| `MONGODB_URI` | Atlas connection string. Must be a replica set (Atlas always is) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay Dashboard → API keys (test mode) |
| `PAYMENT_WEBHOOK_SECRET` | Same secret you set on the Razorpay webhook |
| `ORDER_TTL_SECONDS` | Optional, default 900 (15 min) |

Products (5 SKUs) are added on first start in MongoDB.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/products` | Public catalog |
| POST | `/api/orders` | Needs `Idempotency-Key`. 201 new · 200 same key again · 400 invalid · 409 out of stock · 422 key reused with a different cart |
| GET | `/api/orders` | My orders |
| GET | `/api/orders/:id` | Order status. 404 if not yours |
| POST | `/api/orders/:id/payments` | Create or reuse the Razorpay order. 409 if expired or paid |
| POST | `/api/orders/:id/payments/verify` | Razorpay Checkout callback (signature checked, payment re-fetched) |
| POST | `/webhooks/payment` | Razorpay webhook. HMAC signature required (401 if wrong) |

- **Auth:** `/api/orders/**` needs `Authorization: Bearer <token>`. The hardcoded tokens in `src/config.ts` are `dev-token-guest` and `dev-token-yash`.
- **Scoping:** every order belongs to the token's customer.
- **Money and prices:** money is in paise, and prices always come from the database.

## Order states

```
PENDING_PAYMENT ──paid──────────────► PAID
      │  └─ payment failed → stays pending, customer can retry
      │  └─ wrong amount paid ──────► NEEDS_REVIEW
      └─ 15 min, unpaid ────────────► EXPIRED (stock released)
EXPIRED ── paid late: stock left → PAID, no stock → NEEDS_REVIEW
```

## Edge cases handled

| Case | How |
|---|---|
| Double-click "Place order" | Same `Idempotency-Key` → same order, stock taken once |
| Two shoppers, last unit | Conditional stock update inside a transaction. Tested with 5 parallel orders for 2 units |
| Cart with one item out of stock | All or nothing: 409, no stock taken |
| Abandoned order | Expires after 15 min and releases stock |
| Double-click "Pay" | One payment per order (unique index) |
| Fake webhook | HMAC check on raw body → 401 |
| Payment failed | Order stays pending, customer can retry |
| Partial / wrong amount | `NEEDS_REVIEW`, not PAID |
| Paid after expiry | PAID if stock is still there, otherwise `NEEDS_REVIEW` (refund) |

## Bonus: retry failed payment (agent + human approval)

`docs/retry-failed-payment.schema.json` and its example. An agent can only **propose** a retry, with `orderId`, `reason` and evidence. A human must approve it (`approvedBy`), and it runs once (`actionId`) only if the order is still unpaid.

## Design decisions

### Three tradeoffs

**1. Idempotency key: a client-generated header, scoped per customer.**
The cart creates a UUID and sends it as `Idempotency-Key` when placing the order. The server stores it on the order (unique per customer) together with a hash of the cart. A retry or double-click returns the same order. Reusing the key with a different cart returns 422 instead of the wrong order.
*Rejected:* deduping on cart contents, because a customer may genuinely buy the same thing twice.

**2. Stock is reserved when the order is placed, with a 15-minute expiry.**
The customer never pays for something we can't ship. Abandoned orders release their stock when they expire.
*Rejected:* taking stock on payment success, which can oversell and turns a stock problem into a refund problem.

**3. The webhook is the source of truth; the order page polls.**
An order only becomes PAID from a signed Razorpay event, or from the Checkout callback after the backend re-checks the payment with Razorpay. The order page polls every 2s while payment is pending.
*Rejected:* trusting the browser's "success" (it can be faked or never arrive), and WebSockets (extra moving parts for a few seconds of waiting).

### One failure mode handled: webhook replay / duplicates

In the backend, `src/payments/payments.service.ts` → `handleWebhook()`:
1. Verify the HMAC signature on the raw body (401 if wrong).
2. In one MongoDB transaction: if the event id is already stored, return `duplicate`. Otherwise apply the change and store the event id.

The state change and the event id are saved together, so a crash can't leave one without the other. A second `captured` for the same payment is also a no-op even with a new event id, which covers the webhook and the Checkout callback both arriving.

### What I changed after the first pass

- Moved the Razorpay call out of the DB transaction (transactions can be retried; Razorpay must not be called twice).
- Create a separate "payment attempts" table: one payment per order, retried until captured, is simpler.
- Create "cancel order" to stay in the timebox.
- Would add a common error format for all errors (validation errors still use Nest's default shape).

### Week 2 with real shoppers

First, a reconciliation job that compares recent Razorpay payments with our orders, to catch missed webhooks and stuck orders. Then automatic refunds for the "paid but no stock" and partial-payment cases, behind the human-approval step from the bonus schema. Also: replace the demo tokens with real login, add a queue in front of the webhook, structured logs and alerts on payment failures, and rate limits on order creation.

### Assumptions

- INR only. No tax, shipping, coupons or addresses.
- Max 10 per item, 20 items per order.
- Customers can't cancel; unpaid orders expire.
- Login is a hardcoded demo token.
