import { Controller, Get, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OrdersService } from './orders/orders.service.js';
import { Product } from './schemas.js';

const SEED_PRODUCTS: Product[] = [
  {
    _id: 'YOGA-MAT',
    name: 'Yoga Mat 6mm',
    description: 'Anti-slip TPE mat with carry strap',
    price: 99900,
    stock: 25,
  },
  {
    _id: 'RES-BANDS',
    name: 'Resistance Bands Set',
    description: '5 bands, 10–50 lb',
    price: 64900,
    stock: 40,
  },
  {
    _id: 'SHAKER',
    name: 'Shaker Bottle 700ml',
    description: 'Leak-proof, BPA free',
    price: 34900,
    stock: 50,
  },
  {
    _id: 'GYM-GLOVES',
    name: 'Gym Gloves',
    description: 'Padded palm, wrist support',
    price: 49900,
    stock: 2,
  },
  {
    _id: 'SKIP-ROPE',
    name: 'Skipping Rope',
    description: 'Adjustable steel cable rope',
    price: 29900,
    stock: 0,
  },
];

@Controller('api/products')
export class ProductsController implements OnModuleInit {
  constructor(
    @InjectModel(Product.name) private readonly products: Model<Product>,
    private readonly orders: OrdersService,
  ) {}

  // Insert-if-missing, so restarts (or several instances) never reset stock
  async onModuleInit() {
    await this.products.bulkWrite(
      SEED_PRODUCTS.map((p) => ({
        updateOne: {
          filter: { _id: p._id },
          update: { $setOnInsert: p },
          upsert: true,
        },
      })),
    );
  }

  @Get()
  async list() {
    // Release stock from expired orders so the catalog shows real availability
    await this.orders.expireDueOrders();
    const products = await this.products.find().sort({ _id: 1 }).lean();
    return {
      data: products.map((p) => ({
        sku: p._id,
        name: p.name,
        description: p.description,
        price: p.price,
        stock: p.stock,
        currency: 'INR',
      })),
    };
  }
}
