import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@rideshare/common';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { GatewayEnv } from './config';

async function bootstrap(): Promise<void> {
  // bodyParser off: request bodies must stream to upstreams untouched.
  const app = await NestFactory.create(AppModule.forRoot(), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  const port = app.get<ConfigService<GatewayEnv>>(ConfigService).get('PORT');
  await app.listen(port);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
