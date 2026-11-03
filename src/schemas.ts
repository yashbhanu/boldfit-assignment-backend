import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

// All money is stored in paise (integer) to avoid floating point issues.
// Ids are our own strings (sku, ord_..., pay_..., Razorpay event id) used as _id.

@Schema({ collection: 'products', versionKey: false })
export class Product {
  @Prop({ type: String })
  _id: string; // the SKU

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, required: true })
  description: string;

  @Prop({ type: Number, required: true })
  price: number;

  @Prop({ type: Number, required: true, min: 0 })
  stock: number;
}
export const ProductSchema = SchemaFactory.createForClass(Product);

export enum OrderStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PAID = 'PAID',
  EXPIRED = 'EXPIRED',
  // Money was captured but something is off (partial amount, paid afterexpiry with no stock left). Needs a human to refund or fulfil.
  NEEDS_REVIEW = 'NEEDS_REVIEW',
}

export interface OrderLine {
  sku: string;
  name: string;
  unitPrice: number;
  quantity: number;
}

@Schema({ collection: 'orders', timestamps: true, versionKey: false })
export class Order {
  @Prop({ type: String })
  _id: string;

  @Prop({ type: String, required: true })
  customerId: string;

  @Prop({ type: String, required: true })
  idempotencyKey: string;

  // Hash of the request body, so a reused key with a different cart is rejected
  @Prop({ type: String, required: true })
  requestHash: string;

  @Prop({ type: String, enum: OrderStatus, required: true })
  status: OrderStatus;

  // Snapshot of name/price at the time of order
  @Prop({
    type: [
      {
        _id: false,
        sku: String,
        name: String,
        unitPrice: Number,
        quantity: Number,
      },
    ],
    required: true,
  })
  items: OrderLine[];

  @Prop({ type: Number, required: true })
  totalAmount: number;

  @Prop({ type: String, required: true })
  currency: string;

  @Prop({ type: String, default: null })
  reviewReason: string | null;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  createdAt: Date;
  updatedAt: Date;
}
export const OrderSchema = SchemaFactory.createForClass(Order);
// Idempotency backstop: one order per (customer, Idempotency-Key)
OrderSchema.index({ customerId: 1, idempotencyKey: 1 }, { unique: true });
// For the expiry sweeper
OrderSchema.index({ status: 1, expiresAt: 1 });

export enum PaymentStatus {
  CREATED = 'CREATED',
  FAILED = 'FAILED', // last attempt failed; customer can retry on the same intent
  CAPTURED = 'CAPTURED',
}

// One payment intent per order (maps to one Razorpay order).
@Schema({ collection: 'payments', timestamps: true, versionKey: false })
export class Payment {
  @Prop({ type: String })
  _id: string;

  @Prop({ type: String, required: true, unique: true })
  orderId: string;

  @Prop({ type: String, required: true })
  provider: string;

  @Prop({ type: String, required: true, unique: true })
  providerOrderId: string;

  @Prop({ type: String, default: null })
  providerPaymentId: string | null;

  @Prop({ type: Number, required: true })
  amount: number;

  @Prop({ type: Number, default: null })
  amountPaid: number | null;

  @Prop({ type: String, required: true })
  currency: string;

  @Prop({ type: String, enum: PaymentStatus, required: true })
  status: PaymentStatus;

  @Prop({ type: String, default: null })
  failureReason: string | null;
}
export const PaymentSchema = SchemaFactory.createForClass(Payment);

// Every webhook event id we've processed. Used to drop replays/duplicates.
@Schema({
  collection: 'webhook_events',
  timestamps: { createdAt: 'receivedAt', updatedAt: false },
  versionKey: false,
})
export class WebhookEvent {
  @Prop({ type: String })
  _id: string; // Razorpay's x-razorpay-event-id

  @Prop({ type: String, required: true })
  type: string;

  @Prop({ type: String, required: true })
  result: string;
}
export const WebhookEventSchema = SchemaFactory.createForClass(WebhookEvent);

export type OrderDocument = HydratedDocument<Order>;

export const MODELS = [
  { name: Product.name, schema: ProductSchema },
  { name: Order.name, schema: OrderSchema },
  { name: Payment.name, schema: PaymentSchema },
  { name: WebhookEvent.name, schema: WebhookEventSchema },
];
