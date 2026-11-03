import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import { DbService, isDuplicateKeyError } from '../common/db.service.js';
import { config } from '../config.js';
import { VerifyRazorpayPaymentDto } from '../orders/orders.dto.js';
import { OrdersService } from '../orders/orders.service.js';
import { reserveStock } from '../orders/stock.js';
import {
  Order,
  OrderDocument,
  OrderStatus,
  Payment,
  PaymentStatus,
  Product,
  WebhookEvent,
} from '../schemas.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderPayment,
} from './payment-provider.js';
import { isValidSignature } from './signature.js';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly db: DbService,
    private readonly orders: OrdersService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(Product.name) private readonly productModel: Model<Product>,
    @InjectModel(WebhookEvent.name)
    private readonly webhookEventModel: Model<WebhookEvent>,
  ) {}

  /**
   * Creates the payment intent (a Razorpay order) for an order, or returns
   * the existing one. One intent per order (unique orderId), so double-clicking
   * "Pay" or retrying after a failed attempt never creates a second one.
   */
  async createIntent(customerId: string, orderId: string) {
    const { order, payment: existing } = await this.db.transaction(async () => {
      const order = await this.orders.findOwned(customerId, orderId);
      await this.orders.expireIfDue(order);
      if (order.status !== OrderStatus.PENDING_PAYMENT) {
        throw new ConflictException({
          code: 'ORDER_NOT_PAYABLE',
          message: `Order is ${order.status} and can't be paid`,
        });
      }
      return { order, payment: await this.paymentModel.findOne({ orderId }) };
    });
    if (existing) return { created: false, intent: this.toIntent(existing) };

    // Razorpay is called outside the transaction: transactions can be retried, and a retry must not create a second Razorpay order.
    let providerOrder: { id: string };
    try {
      providerOrder = await this.provider.createOrder({
        amount: order.totalAmount,
        currency: order.currency,
        receipt: order._id,
      });
    } catch (err) {
      this.logger.error(`Provider createOrder failed for ${orderId}`, err);
      throw new BadGatewayException({
        code: 'PROVIDER_ERROR',
        message: 'Payment provider unavailable, try again',
      });
    }

    try {
      const payment = await new this.paymentModel({
        _id: `pay_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        orderId,
        provider: this.provider.name,
        providerOrderId: providerOrder.id,
        amount: order.totalAmount,
        currency: order.currency,
        status: PaymentStatus.CREATED,
      }).save();
      return { created: true, intent: this.toIntent(payment) };
    } catch (err) {
      // A concurrent click won the race (unique orderId). Use its intent; the extra Razorpay order we just made is never paid and simply lapses.
      if (!isDuplicateKeyError(err)) throw err;
      const winner = await this.paymentModel.findOne({ orderId }).orFail();
      return { created: false, intent: this.toIntent(winner) };
    }
  }

  /**
   * POST /webhooks/payment. The webhook is the source of truth for payment state.
   * - Signature checked against the raw body (401 if bad)
   * - Event id recorded in the same transaction as the state change, so a
   *   replay is a no-op and a crash mid-way lets Razorpay retry cleanly
   */
  async handleWebhook(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    eventIdHeader: string | undefined,
  ) {
    if (
      !rawBody ||
      !isValidSignature(rawBody, signature, config.webhookSecret())
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_SIGNATURE',
        message: 'Invalid webhook signature',
      });
    }

    const event = parseEvent(rawBody);
    // Razorpay sends x-razorpay-event-id; fall back to a hash of the body
    const eventId =
      eventIdHeader || createHash('sha256').update(rawBody).digest('hex');

    try {
      return await this.db.transaction(async () => {
        if (await this.webhookEventModel.exists({ _id: eventId })) {
          return { received: true, result: 'duplicate' };
        }
        const result = await this.applyPaymentUpdate(event.type, event.payment);
        await new this.webhookEventModel({
          _id: eventId,
          type: event.type,
          result,
        }).save();
        return { received: true, result };
      });
    } catch (err) {
      // The same event delivered twice at the same moment: the other copy won
      if (isDuplicateKeyError(err))
        return { received: true, result: 'duplicate' };
      throw err;
    }
  }

  /**
   * Razorpay Checkout.js success callback. Confirms the order even if the
   * webhook is slow. We verify the callback signature, then ask Razorpay
   * for the real payment status instead of trusting the browser.
   */
  async verifyRazorpayCallback(
    customerId: string,
    orderId: string,
    dto: VerifyRazorpayPaymentDto,
  ) {
    const payload = `${dto.razorpay_order_id}|${dto.razorpay_payment_id}`;
    if (
      !isValidSignature(
        payload,
        dto.razorpay_signature,
        config.razorpayKeySecret(),
      )
    ) {
      throw new BadRequestException({
        code: 'INVALID_SIGNATURE',
        message: 'Invalid payment signature',
      });
    }
    const providerPayment = await this.provider.fetchPayment(
      dto.razorpay_payment_id,
    );

    return this.db.transaction(async () => {
      await this.orders.findOwned(customerId, orderId);
      const payment = await this.paymentModel.findOne({ orderId });
      if (payment?.providerOrderId !== providerPayment.order_id) {
        throw new BadRequestException({
          code: 'PAYMENT_ORDER_MISMATCH',
          message: 'This payment does not belong to this order',
        });
      }
      const eventType =
        providerPayment.status === 'captured'
          ? 'payment.captured'
          : providerPayment.status === 'failed'
            ? 'payment.failed'
            : 'payment.pending';
      return {
        result: await this.applyPaymentUpdate(eventType, providerPayment),
      };
    });
  }

  /**
   * The order/payment state machine. Safe to call more than once for the
   * same payment (webhook + checkout callback can both arrive).
   * Runs inside a transaction.
   */
  private async applyPaymentUpdate(
    eventType: string,
    p: ProviderPayment,
  ): Promise<string> {
    const payment = await this.paymentModel.findOne({
      providerOrderId: p.order_id,
    });
    if (!payment) return 'ignored:unknown_order';
    const order = await this.orderModel.findById(payment.orderId).orFail();

    if (eventType === 'payment.failed') {
      // Events can arrive out of order: a late "failed" must not undo a capture
      if (payment.status === PaymentStatus.CAPTURED)
        return 'ignored:already_captured';
      payment.status = PaymentStatus.FAILED;
      payment.failureReason = p.error_description ?? 'Payment failed';
      await payment.save();
      // Order stays PENDING_PAYMENT so the customer can retry until it expires
      return 'payment_failed';
    }

    if (eventType !== 'payment.captured') return `ignored:${eventType}`;
    if (payment.status === PaymentStatus.CAPTURED)
      return 'ignored:already_captured';

    payment.status = PaymentStatus.CAPTURED;
    payment.providerPaymentId = p.id;
    payment.amountPaid = p.amount;
    payment.failureReason = null;
    await payment.save();

    // Partial / mismatched amount: don't mark PAID, flag for a human
    if (p.amount !== order.totalAmount || p.currency !== order.currency) {
      return this.markForReview(
        order,
        `Captured ${p.amount} ${p.currency} but order total is ${order.totalAmount} ${order.currency}`,
      );
    }

    // Paid after the reservation expired: re-take stock if it's still there
    if (order.status === OrderStatus.EXPIRED) {
      const reservation = await reserveStock(this.productModel, order.items);
      if (!reservation.ok) {
        return this.markForReview(
          order,
          'Paid after order expired and stock is gone; refund required',
        );
      }
    }

    if (
      order.status === OrderStatus.PENDING_PAYMENT ||
      order.status === OrderStatus.EXPIRED
    ) {
      order.status = OrderStatus.PAID;
      await order.save();
      return 'order_paid';
    }
    return `ignored:order_${order.status}`;
  }

  private async markForReview(order: OrderDocument, reason: string) {
    this.logger.warn(`Order ${order._id} needs review: ${reason}`);
    order.status = OrderStatus.NEEDS_REVIEW;
    order.reviewReason = reason;
    await order.save();
    return 'needs_review';
  }

  private toIntent(payment: Payment) {
    return {
      paymentId: payment._id,
      status: payment.status,
      provider: payment.provider,
      providerOrderId: payment.providerOrderId,
      amount: payment.amount,
      currency: payment.currency,
      razorpayKeyId: this.provider.publicKey,
    };
  }
}

function parseEvent(rawBody: Buffer): {
  type: string;
  payment: ProviderPayment;
} {
  try {
    const body = JSON.parse(rawBody.toString('utf8'));
    const payment = body?.payload?.payment?.entity;
    if (
      typeof body.event === 'string' &&
      typeof payment?.order_id === 'string' &&
      Number.isInteger(payment?.amount)
    ) {
      return { type: body.event, payment };
    }
  } catch {
    // fall through
  }
  throw new BadRequestException({
    code: 'INVALID_PAYLOAD',
    message: 'Malformed webhook payload',
  });
}
