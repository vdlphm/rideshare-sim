import { Module } from '@nestjs/common';
import { TokenVerifierModule } from '../token-verifier';
import { LiveGateway } from './live.gateway';
import { LiveService } from './live.service';
import { HttpLiveUpstreams, LIVE_UPSTREAMS } from './upstreams';

/** Admin live-view WebSocket (`/ws`) and the poller behind it. */
@Module({
  imports: [TokenVerifierModule],
  providers: [LiveService, LiveGateway, { provide: LIVE_UPSTREAMS, useClass: HttpLiveUpstreams }],
})
export class LiveModule {}
