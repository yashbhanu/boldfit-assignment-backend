import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard, CustomerId } from '../common/auth.guard.js';
import { PaymentsService } from '../payments/payments.service.js';
import { CreateOrderDto, VerifyRazorpayPaymentDto } from './orders.dto.js';
import { OrdersService } from './orders.service.js';

@Controller('api/orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
  ) {}

  /** 201 = new order, 200 = same Idempotency-Key replayed, original order returned */
  @Post()
  async create(
    @CustomerId() customerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || !/^[\w-]{8,100}$/.test(idempotencyKey)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message:
          'Idempotency-Key header is required (8-100 chars: letters, digits, - or _)',
      });
    }
    const { created, order } = await this.orders.create(
      customerId,
      idempotencyKey,
      dto,
    );
    res.status(created ? 201 : 200);
    return order;
  }

  @Get()
  async list(@CustomerId() customerId: string) {
    return { data: await this.orders.list(customerId) };
  }

  @Get(':id')
  get(@CustomerId() customerId: string, @Param('id') id: string) {
    return this.orders.get(customerId, id);
  }

  /** 201 = intent created, 200 = existing intent for this order returned */
  @Post(':id/payments')
  async createPayment(
    @CustomerId() customerId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, intent } = await this.payments.createIntent(
      customerId,
      id,
    );
    res.status(created ? 201 : 200);
    return intent;
  }

  @Post(':id/payments/verify')
  @HttpCode(200)
  verifyPayment(
    @CustomerId() customerId: string,
    @Param('id') id: string,
    @Body() dto: VerifyRazorpayPaymentDto,
  ) {
    return this.payments.verifyRazorpayCallback(customerId, id, dto);
  }
}
