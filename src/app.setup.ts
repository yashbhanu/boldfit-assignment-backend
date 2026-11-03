import { INestApplication, ValidationPipe } from '@nestjs/common';

// Shared by main.ts and the e2e tests
export function configureApp(app: INestApplication) {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableCors();
}
