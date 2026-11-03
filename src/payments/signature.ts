import { createHmac, timingSafeEqual } from 'node:crypto';

// Same scheme Razorpay uses: hex(HMAC-SHA256(body, secret))
export function sign(body: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function isValidSignature(
  body: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(sign(body, secret));
  const received = Buffer.from(signature);
  // timingSafeEqual throws on length mismatch, so check that first
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}
