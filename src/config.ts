export const config = {
  port: () => Number(process.env.PORT ?? 3000),
  mongodbUri: () => process.env.MONGODB_URI ?? '',
  orderTtlSeconds: () => Number(process.env.ORDER_TTL_SECONDS ?? 900),
  webhookSecret: () =>
    process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev_webhook_secret',
  razorpayKeyId: () => process.env.RAZORPAY_KEY_ID ?? '',
  razorpayKeySecret: () => process.env.RAZORPAY_KEY_SECRET ?? '',
};

// Hardcoded bearer tokens -> customer id.
export const CUSTOMER_TOKENS: Record<string, string> = {
  'dev-token-guest': 'cust_guest',
  'dev-token-yash': 'cust_yash',
};
