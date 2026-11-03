import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { DbService } from './common/db.service.js';
import { config } from './config.js';
import { OrdersController } from './orders/orders.controller.js';
import { OrdersService } from './orders/orders.service.js';
import {
  createPaymentProvider,
  PAYMENT_PROVIDER,
} from './payments/payment-provider.js';
import { PaymentsService } from './payments/payments.service.js';
import { WebhooksController } from './payments/webhooks.controller.js';
import { ProductsController } from './products.controller.js';
import { MODELS } from './schemas.js';

@Module({
  imports: [
    ConfigModule.forRoot(),
    MongooseModule.forRootAsync({
      useFactory: () => {
        const uri = config.mongodbUri();
        if (!uri) throw new Error('Set MONGODB_URI in .env');
        return { uri };
      },
    }),
    MongooseModule.forFeature(MODELS),
  ],
  controllers: [ProductsController, OrdersController, WebhooksController],
  providers: [
    DbService,
    OrdersService,
    PaymentsService,
    { provide: PAYMENT_PROVIDER, useFactory: createPaymentProvider },
  ],
})
export class AppModule {}
