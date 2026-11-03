import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { config } from './config.js';

async function bootstrap() {
  // rawBody: true keeps the exact request bytes for webhook signature checks
  const app = await NestFactory.create(AppModule, { rawBody: true });
  configureApp(app);
  await app.listen(config.port());
}
await bootstrap();
