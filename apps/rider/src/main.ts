import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@rideshare/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { RiderEnv } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule.forRoot(), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  const port = app.get<ConfigService<RiderEnv>>(ConfigService).get('PORT');
  await app.listen(port);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
