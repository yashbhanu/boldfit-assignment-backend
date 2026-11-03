import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Order, Payment } from '../schemas.js';

export class OrderItemDto {
  @IsString()
  sku: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity: number;
}

export class CreateOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}

// Body sent by Razorpay Checkout.js to the success handler
export class VerifyRazorpayPaymentDto {
  @IsString()
  razorpay_order_id: string;

  @IsString()
  razorpay_payment_id: string;

  @IsString()
  razorpay_signature: string;
}

export function toOrderResponse(order: Order, payment: Payment | null) {
  return {
    id: order._id,
    status: order.status,
    items: order.items,
    totalAmount: order.totalAmount,
    currency: order.currency,
    reviewReason: order.reviewReason,
    expiresAt: order.expiresAt,
    createdAt: order.createdAt,
    payment: payment && {
      id: payment._id,
      status: payment.status,
      provider: payment.provider,
      amountPaid: payment.amountPaid,
      failureReason: payment.failureReason,
    },
  };
}
