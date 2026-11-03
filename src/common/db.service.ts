import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import mongoose, { type Connection } from 'mongoose';

// Every query run inside connection.transaction(fn) automatically uses that transaction's session, so services don't have to pass `session` around.
mongoose.set('transactionAsyncLocalStorage', true);

@Injectable()
export class DbService implements OnModuleInit {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  // Make sure unique indexes exist before we serve traffic: idempotency and webhook dedupe rely on them.
  async onModuleInit() {
    await Promise.all(
      Object.values(this.connection.models).map((m) => m.init()),
    );
  }

  transaction<T>(work: () => Promise<T>): Promise<T> {
    return this.connection.transaction(() => work());
  }
}

export function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}
