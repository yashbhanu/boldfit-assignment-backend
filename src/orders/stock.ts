import { Model } from 'mongoose';
import { Product } from '../schemas.js';

export interface Shortage {
  sku: string;
  requested: number;
  available: number;
}

type Line = { sku: string; quantity: number };

/**
 * Takes stock for every line, or nothing at all.
 * Call inside DbService.transaction().
 */
export async function reserveStock(
  products: Model<Product>,
  lines: Line[],
): Promise<{ ok: true } | { ok: false; shortages: Shortage[] }> {
  const found = await products
    .find({ _id: { $in: lines.map((l) => l.sku) } })
    .lean();
  const stockBySku = new Map(found.map((p) => [p._id, p.stock]));

  const shortages = lines
    .map((l) => ({
      sku: l.sku,
      requested: l.quantity,
      available: stockBySku.get(l.sku) ?? 0,
    }))
    .filter((s) => s.available < s.requested);
  if (shortages.length > 0) return { ok: false, shortages };

  const taken: Line[] = [];
  for (const l of lines) {
    // Conditional decrement: never lets stock go below zero, even if another order changed it after our read above
    const res = await products.updateOne(
      { _id: l.sku, stock: { $gte: l.quantity } },
      { $inc: { stock: -l.quantity } },
    );
    if (res.modifiedCount === 0) {
      await releaseStock(products, taken);
      return {
        ok: false,
        shortages: [{ sku: l.sku, requested: l.quantity, available: 0 }],
      };
    }
    taken.push(l);
  }
  return { ok: true };
}

export async function releaseStock(products: Model<Product>, lines: Line[]) {
  for (const l of lines) {
    await products.updateOne({ _id: l.sku }, { $inc: { stock: l.quantity } });
  }
}
