import { isValidSignature, sign } from './signature.js';

describe('webhook signature', () => {
  const body = '{"event":"payment.captured"}';

  it('accepts a correctly signed body', () => {
    expect(isValidSignature(body, sign(body, 'secret'), 'secret')).toBe(true);
  });

  it('rejects a wrong secret, a tampered body, or a missing signature', () => {
    expect(isValidSignature(body, sign(body, 'other'), 'secret')).toBe(false);
    expect(isValidSignature(body + ' ', sign(body, 'secret'), 'secret')).toBe(
      false,
    );
    expect(isValidSignature(body, undefined, 'secret')).toBe(false);
    expect(isValidSignature(body, 'short', 'secret')).toBe(false);
  });
});
