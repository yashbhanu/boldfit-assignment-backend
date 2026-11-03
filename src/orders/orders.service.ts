import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import { DbService, isDuplicateKeyError } from '../common/db.service.js';
import { config } from '../config.js';
import {
  Order,
  OrderDocument,
  OrderStatus,
  Payment,
  Product,
} from '../schemas.js';
import { CreateOrderDto, toOrderResponse } from './orders.dto.js';
import { releaseStock, reserveStock } from './stock.js';

type Line = { sku: string; quantity: number };

@Injectable()
export class OrdersService implements OnModuleInit, OnModuleDestroy {
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    @InjectModel(Order.name) private readonly orders: Model<Order>,
    @InjectModel(Product.name) private readonly products: Model<Product>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
  ) {}

  // Periodically expire unpaid orders so their stock goes back on sale.
  onModuleInit() {
    this.sweeper = setInterval(() => void this.expireDueOrders(), 30_000);
    this.sweeper.unref();
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }

  async create(
    customerId: string,
    idempotencyKey: string,
    dto: CreateOrderDto,
  ) {
    const lines = mergeDuplicateSkus(dto.items);
    const requestHash = createHash('sha256')
      .update(JSON.stringify(lines))
      .digest('hex');
    const attempt = () =>
      this.db.transaction(() =>
        this.createOrReturnExisting(
          customerId,
          idempotencyKey,
          requestHash,
          lines,
        ),
      );

    try {
      return await attempt();
    } catch (err) {
      // Two requests with the same key at the same moment: the loser hits the unique index (and its stock reservation is rolled back). Running again finds the winner's order and returns it.
      if (isDuplicateKeyError(err)) return attempt();
      throw err;
    }
  }

  private async createOrReturnExisting(
    customerId: string,
    idempotencyKey: string,
    requestHash: string,
    lines: Line[],
  ) {
    const existing = await this.orders.findOne({ customerId, idempotencyKey });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new UnprocessableEntityException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message:
            'This Idempotency-Key was already used with a different cart',
        });
      }
      return { created: false, order: await this.view(existing) };
    }

    // Prices come from the DB
    const products = await this.products
      .find({ _id: { $in: lines.map((l) => l.sku) } })
      .lean();
    const bySku = new Map(products.map((p) => [p._id, p]));
    const unknown = lines.filter((l) => !bySku.has(l.sku)).map((l) => l.sku);
    if (unknown.length > 0) {
      throw new BadRequestException({
        code: 'UNKNOWN_SKU',
        message: `Unknown SKU(s): ${unknown.join(', ')}`,
      });
    }

    const reservation = await reserveStock(this.products, lines);
    if (!reservation.ok) {
      throw new ConflictException({
        code: 'OUT_OF_STOCK',
        message: 'Some items are out of stock',
        details: reservation.shortages,
      });
    }

    const items = lines.map((l) => {
      const p = bySku.get(l.sku)!;
      return {
        sku: p._id,
        name: p.name,
        unitPrice: p.price,
        quantity: l.quantity,
      };
    });
    const order = await new this.orders({
      _id: `ord_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      customerId,
      idempotencyKey,
      requestHash,
      status: OrderStatus.PENDING_PAYMENT,
      items,
      totalAmount: items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0),
      currency: 'INR',
      expiresAt: new Date(Date.now() + config.orderTtlSeconds() * 1000),
    }).save();
    return { created: true, order: await this.view(order) };
  }

  async list(customerId: string) {
    return this.db.transaction(async () => {
      const orders = await this.orders
        .find({ customerId })
        .sort({ createdAt: -1 });
      for (const o of orders) await this.expireIfDue(o);
      return Promise.all(orders.map((o) => this.view(o)));
    });
  }

  async get(customerId: string, orderId: string) {
    return this.db.transaction(async () => {
      const order = await this.findOwned(customerId, orderId);
      await this.expireIfDue(order);
      return this.view(order);
    });
  }

  // Another customer's order is reported as 404 (not 403) so ids can't be probed.
  async findOwned(customerId: string, orderId: string) {
    const order = await this.orders.findById(orderId);
    if (!order || order.customerId !== customerId) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Order not found',
      });
    }
    return order;
  }

  /** PENDING_PAYMENT -> EXPIRED once the reservation window has passed. */
  async expireIfDue(order: OrderDocument) {
    if (
      order.status !== OrderStatus.PENDING_PAYMENT ||
      order.expiresAt > new Date()
    )
      return;
    // Conditional on the current status, so stock is released exactly once even if the sweeper and a request (or two instances) race
    const res = await this.orders.updateOne(
      { _id: order._id, status: OrderStatus.PENDING_PAYMENT },
      { $set: { status: OrderStatus.EXPIRED } },
    );
    if (res.modifiedCount === 1) await releaseStock(this.products, order.items);
    order.status = OrderStatus.EXPIRED;
  }

  async expireDueOrders() {
    const due = await this.orders.find({
      status: OrderStatus.PENDING_PAYMENT,
      expiresAt: { $lt: new Date() },
    });
    for (const o of due) {
      await this.db.transaction(() => this.expireIfDue(o));
    }
  }

  private async view(order: Order) {
    const payment = await this.payments.findOne({ orderId: order._id }).lean();
    return toOrderResponse(order, payment);
  }
}

function mergeDuplicateSkus(items: Line[]) {
  const qty = new Map<string, number>();
  for (const i of items) qty.set(i.sku, (qty.get(i.sku) ?? 0) + i.quantity);
  return [...qty.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sku, quantity]) => ({ sku, quantity }));
}
