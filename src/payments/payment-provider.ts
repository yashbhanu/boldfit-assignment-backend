import Razorpay from 'razorpay';
import { config } from '../config.js';

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export interface PaymentProvider {
  readonly name: string;
  readonly publicKey: string;
  createOrder(input: {
    amount: number;
    currency: string;
    receipt: string;
  }): Promise<{ id: string }>;
  /** Look up a payment's real status (used to verify the Checkout.js callback). */
  fetchPayment(paymentId: string): Promise<ProviderPayment>;
}

// Subset of Razorpay's payment entity that we use (also the webhook payload shape)
export interface ProviderPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string; // created | authorized | captured | failed | refunded
  error_description?: string | null;
}

export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = 'razorpay';
  readonly publicKey: string;
  private readonly client: Razorpay;

  constructor() {
    const keyId = config.razorpayKeyId();
    const keySecret = config.razorpayKeySecret();
    if (!keyId || !keySecret) {
      throw new Error(
        'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (test keys) in .env',
      );
    }
    this.publicKey = keyId;
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }

  async createOrder(input: {
    amount: number;
    currency: string;
    receipt: string;
  }) {
    const order = await this.client.orders.create(input);
    return { id: order.id };
  }

  async fetchPayment(paymentId: string) {
    return (await this.client.payments.fetch(
      paymentId,
    )) as unknown as ProviderPayment;
  }
}

export function createPaymentProvider(): PaymentProvider {
  return new RazorpayPaymentProvider();
}
