import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { getModelToken } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Model } from 'mongoose';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { randomUUID } from 'node:crypto';
import { Order, Payment, PaymentStatus, Product } from '../src/schemas.js';
import { sign } from '../src/payments/signature.js';

const GUEST = 'Bearer dev-token-guest';
const YASH = 'Bearer dev-token-yash';
const SECRET = 'test_webhook_secret';
const KEY_SECRET = 'test_key_secret';

/** Razorpay-shaped webhook body, as Razorpay would POST it. */
function buildWebhookEvent(
  type: 'payment.captured' | 'payment.failed',
  payment: {
    orderId: string;
    amount: number;
    currency: string;
    errorDescription?: string;
  },
) {
  return {
    entity: 'event',
    event: type,
    contains: ['payment'],
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: `pay_${randomUUID().slice(0, 12)}`,
          entity: 'payment',
          order_id: payment.orderId,
          amount: payment.amount,
          currency: payment.currency,
          status: type === 'payment.captured' ? 'captured' : 'failed',
          error_description: payment.errorDescription ?? null,
        },
      },
    },
  };
}

describe('Checkout flow (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  // Transactions need a replica set, so tests run against a 1-node in-memory one
  let mongo: MongoMemoryReplSet;
  let dbCount = 0;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  }, 120_000);

  afterAll(() => mongo.stop());

  beforeEach(async () => {
    // The real Razorpay provider is wired up, but no test calls the Razorpay
    // API: payments are seeded in the DB and confirmed via signed webhooks.
    process.env.MONGODB_URI = mongo.getUri(`test_${++dbCount}`); // fresh DB per test
    process.env.PAYMENT_WEBHOOK_SECRET = SECRET;
    process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
    process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
  });

  afterEach(() => app.close());

  const createOrder = (key: string, items: object[], token = GUEST) =>
    http
      .post('/api/orders')
      .set('Authorization', token)
      .set('Idempotency-Key', key)
      .send({ items });

  const createIntent = (orderId: string) =>
    http.post(`/api/orders/${orderId}/payments`).set('Authorization', GUEST);

  const sendWebhook = (eventId: string, event: object, secret = SECRET) => {
    const body = JSON.stringify(event);
    return http
      .post('/webhooks/payment')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-event-id', eventId)
      .set('x-razorpay-signature', sign(body, secret))
      .send(body);
  };

  const getOrder = (id: string) =>
    http.get(`/api/orders/${id}`).set('Authorization', GUEST);

  const model = <T>(cls: { name: string }) =>
    app.get<Model<T>>(getModelToken(cls.name));

  const stockOf = async (sku: string) =>
    (await model<Product>(Product).findById(sku).orFail()).stock;

  /** Pretend the reservation window has already passed */
  const expireNow = (orderId: string) =>
    model<Order>(Order).updateOne(
      { _id: orderId },
      { expiresAt: new Date(Date.now() - 1000) },
    );

  /**
   * An order plus its payment row, i.e. the state right after Razorpay
   * created the order (inserted directly so tests don't call Razorpay).
   */
  async function pendingOrder(
    key: string,
    items = [{ sku: 'SHAKER', quantity: 1 }],
  ) {
    const order = (await createOrder(key, items).expect(201)).body;
    const payment = await model<Payment>(Payment).create({
      _id: `pay_${randomUUID().slice(0, 16)}`,
      orderId: order.id,
      provider: 'razorpay',
      providerOrderId: `order_${randomUUID().slice(0, 14)}`,
      amount: order.totalAmount,
      currency: 'INR',
      status: PaymentStatus.CREATED,
    });
    const intent = {
      paymentId: payment._id,
      providerOrderId: payment.providerOrderId,
      amount: payment.amount,
    };
    return { order, intent };
  }

  describe('orders', () => {
    it('requires a bearer token', async () => {
      await http.post('/api/orders').send({ items: [] }).expect(401);
    });

    it('requires an Idempotency-Key and validates the body', async () => {
      await http
        .post('/api/orders')
        .set('Authorization', GUEST)
        .send({ items: [{ sku: 'SHAKER', quantity: 1 }] })
        .expect(400);
      await createOrder('key-invalid-body', [
        { sku: 'SHAKER', quantity: 0 },
      ]).expect(400);
      await createOrder('key-unknown-sku', [
        { sku: 'NOPE', quantity: 1 },
      ]).expect(400);
    });

    it('uses server-side prices and reserves stock', async () => {
      const res = await createOrder('key-price-0001', [
        { sku: 'SHAKER', quantity: 2, price: 1 },
      ]);
      expect(res.status).toBe(400); // unknown field "price" is rejected

      const ok = await createOrder('key-price-0002', [
        { sku: 'SHAKER', quantity: 2 },
      ]).expect(201);
      expect(ok.body.totalAmount).toBe(2 * 34900);
      expect(ok.body.status).toBe('PENDING_PAYMENT');
      expect(await stockOf('SHAKER')).toBe(48);
    });

    it('double-submit with the same key returns the same order and reserves stock once', async () => {
      const items = [{ sku: 'SHAKER', quantity: 1 }];
      const [a, b] = await Promise.all([
        createOrder('key-double-01', items),
        createOrder('key-double-01', items),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect(await stockOf('SHAKER')).toBe(49);
    });

    it('rejects a reused key with a different cart (422)', async () => {
      await createOrder('key-reuse-001', [
        { sku: 'SHAKER', quantity: 1 },
      ]).expect(201);
      await createOrder('key-reuse-001', [
        { sku: 'SHAKER', quantity: 3 },
      ]).expect(422);
    });

    it('never oversells under concurrent checkouts', async () => {
      // GYM-GLOVES has stock 2
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          createOrder(`key-race-000${i}`, [{ sku: 'GYM-GLOVES', quantity: 1 }]),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      expect(results.find((r) => r.status === 409)!.body.code).toBe(
        'OUT_OF_STOCK',
      );
      expect(await stockOf('GYM-GLOVES')).toBe(0);
    });

    it('rolls back a partial reservation when one item is out of stock', async () => {
      // SHAKER is available, SKIP-ROPE is sold out: nothing may be taken
      const res = await createOrder('key-rollback1', [
        { sku: 'SHAKER', quantity: 1 },
        { sku: 'SKIP-ROPE', quantity: 1 },
      ]).expect(409);
      expect(res.body.details).toEqual([
        { sku: 'SKIP-ROPE', requested: 1, available: 0 },
      ]);
      expect(await stockOf('SHAKER')).toBe(50);
    });

    it("hides other customers' orders (404)", async () => {
      const { body } = await createOrder('key-owner-01', [
        { sku: 'SHAKER', quantity: 1 },
      ]).expect(201);
      await http
        .get(`/api/orders/${body.id}`)
        .set('Authorization', YASH)
        .expect(404);
    });

    it('expires unpaid orders and releases stock', async () => {
      const { body } = await createOrder('key-expire-1', [
        { sku: 'GYM-GLOVES', quantity: 2 },
      ]).expect(201);
      await expireNow(body.id);

      expect((await getOrder(body.id)).body.status).toBe('EXPIRED');
      expect(await stockOf('GYM-GLOVES')).toBe(2);
      await createIntent(body.id).expect(409);
    });
  });

  describe('payments + webhook', () => {
    it('rejects an invalid signature (401) and a malformed body (400)', async () => {
      const { intent } = await pendingOrder('key-sig-0001');
      const event = buildWebhookEvent('payment.captured', {
        orderId: intent.providerOrderId,
        amount: intent.amount,
        currency: 'INR',
      });
      await sendWebhook('evt_1', event, 'wrong_secret').expect(401);
      await sendWebhook('evt_2', { hello: 'world' }).expect(400);
    });

    it('confirms the order on capture and ignores replays', async () => {
      const { order, intent } = await pendingOrder('key-paid-001');
      const event = buildWebhookEvent('payment.captured', {
        orderId: intent.providerOrderId,
        amount: intent.amount,
        currency: 'INR',
      });

      expect(
        (await sendWebhook('evt_paid', event).expect(200)).body.result,
      ).toBe('order_paid');
      expect(
        (await sendWebhook('evt_paid', event).expect(200)).body.result,
      ).toBe('duplicate');

      const res = await getOrder(order.id);
      expect(res.body.status).toBe('PAID');
      expect(res.body.payment.status).toBe('CAPTURED');
    });

    it('lets the customer retry after a failed payment', async () => {
      const { order, intent } = await pendingOrder('key-retry-01');
      const failed = buildWebhookEvent('payment.failed', {
        orderId: intent.providerOrderId,
        amount: intent.amount,
        currency: 'INR',
        errorDescription: 'Card declined',
      });
      await sendWebhook('evt_fail', failed).expect(200);

      let res = await getOrder(order.id);
      expect(res.body.status).toBe('PENDING_PAYMENT');
      expect(res.body.payment).toMatchObject({
        status: 'FAILED',
        failureReason: 'Card declined',
      });

      // Retry reuses the same intent
      expect((await createIntent(order.id).expect(200)).body.paymentId).toBe(
        intent.paymentId,
      );
      const captured = buildWebhookEvent('payment.captured', {
        orderId: intent.providerOrderId,
        amount: intent.amount,
        currency: 'INR',
      });
      await sendWebhook('evt_ok', captured).expect(200);
      res = await getOrder(order.id);
      expect(res.body.status).toBe('PAID');
    });

    it('ignores a "failed" event that arrives after the capture', async () => {
      const { order, intent } = await pendingOrder('key-ooo-0001');
      const p = {
        orderId: intent.providerOrderId,
        amount: intent.amount,
        currency: 'INR',
      };
      await sendWebhook(
        'evt_a',
        buildWebhookEvent('payment.captured', p),
      ).expect(200);
      const res = await sendWebhook(
        'evt_b',
        buildWebhookEvent('payment.failed', p),
      ).expect(200);
      expect(res.body.result).toBe('ignored:already_captured');
      expect((await getOrder(order.id)).body.status).toBe('PAID');
    });

    it('flags a partial payment for review instead of marking it paid', async () => {
      const { order, intent } = await pendingOrder('key-partial1');
      const event = buildWebhookEvent('payment.captured', {
        orderId: intent.providerOrderId,
        amount: intent.amount - 100,
        currency: 'INR',
      });
      await sendWebhook('evt_partial', event).expect(200);
      const res = await getOrder(order.id);
      expect(res.body.status).toBe('NEEDS_REVIEW');
      expect(res.body.reviewReason).toContain('Captured');
    });

    it('accepts a late payment on an expired order if stock is still available', async () => {
      const { order, intent } = await pendingOrder('key-late-001', [
        { sku: 'GYM-GLOVES', quantity: 1 },
      ]);
      await expireNow(order.id);
      expect((await getOrder(order.id)).body.status).toBe('EXPIRED');

      const event = buildWebhookEvent('payment.captured', {
        orderId: intent.providerOrderId,
        amount: intent.amount,
        currency: 'INR',
      });
      await sendWebhook('evt_late', event).expect(200);
      expect((await getOrder(order.id)).body.status).toBe('PAID');
      expect(await stockOf('GYM-GLOVES')).toBe(1);
    });

    it('flags a late payment for refund if the stock was sold meanwhile', async () => {
      const { order, intent } = await pendingOrder('key-late-002', [
        { sku: 'GYM-GLOVES', quantity: 2 },
      ]);
      await expireNow(order.id);
      await getOrder(order.id); // expires it, stock back to 2
      await createOrder('key-late-003', [
        { sku: 'GYM-GLOVES', quantity: 2 },
      ]).expect(201); // someone else buys it

      const event = buildWebhookEvent('payment.captured', {
        orderId: intent.providerOrderId,
        amount: intent.amount,
        currency: 'INR',
      });
      await sendWebhook('evt_late2', event).expect(200);
      const res = await getOrder(order.id);
      expect(res.body.status).toBe('NEEDS_REVIEW');
      expect(res.body.reviewReason).toContain('refund');
    });
  });

  describe('Razorpay Checkout callback (/payments/verify)', () => {
    const verify = (orderId: string, body: object) =>
      http
        .post(`/api/orders/${orderId}/payments/verify`)
        .set('Authorization', GUEST)
        .send(body);

    it('rejects a forged callback signature', async () => {
      const { order, intent } = await pendingOrder('key-verify-02');
      await verify(order.id, {
        razorpay_order_id: intent.providerOrderId,
        razorpay_payment_id: 'pay_forged',
        razorpay_signature: 'not-a-real-signature',
      }).expect(400);
      expect((await getOrder(order.id)).body.status).toBe('PENDING_PAYMENT');
    });
  });
});
