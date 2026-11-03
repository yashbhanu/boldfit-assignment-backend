import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentsService } from './payments.service.js';

/**
 * Called by the payment provider, not the browser, so there's no bearer
 * token. It's authenticated by the HMAC signature instead.
 * Always 200 for valid events (including duplicates/ignored) so the provider
 * stops retrying; 401 bad signature, 400 malformed, 5xx = please retry.
 */
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('payment')
  @HttpCode(200)
  handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ) {
    return this.payments.handleWebhook(req.rawBody, signature, eventId);
  }
}
