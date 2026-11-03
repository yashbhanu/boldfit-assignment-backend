import { NestFactory } from '@nestjs/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// Vercel entry point (used by api/index.js). Instead of app.listen(), the
// Nest app is built once per function instance and reused for every request.
let server: Promise<Handler> | undefined;

async function createServer(): Promise<Handler> {
  // rawBody: true keeps the exact request bytes for webhook signature checks
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);
  await app.init();
  return app.getHttpAdapter().getInstance() as Handler;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  // If startup fails (e.g. MongoDB unreachable), retry on the next request
  server ??= createServer().catch((err: unknown) => {
    server = undefined;
    throw err;
  });
  (await server)(req, res);
}
