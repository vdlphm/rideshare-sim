import { Body, Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { Public } from '@rideshare/common';
import {
  LoginRequestSchema,
  RefreshRequestSchema,
  ServiceTokenRequestSchema,
  type ServiceTokenResponse,
  type TokenPair,
} from '@rideshare/contracts';
import { createZodDto } from 'nestjs-zod';
import { KeyService, type PublicJwk } from '../keys/key.service';
import { AuthService } from './auth.service';

class LoginDto extends createZodDto(LoginRequestSchema) {}
class RefreshDto extends createZodDto(RefreshRequestSchema) {}
class ServiceTokenDto extends createZodDto(ServiceTokenRequestSchema) {}

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly keys: KeyService,
  ) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  login(@Body() body: LoginDto): Promise<TokenPair> {
    return this.auth.login(body.email, body.password);
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(200)
  refresh(@Body() body: RefreshDto): Promise<TokenPair> {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @Post('auth/token')
  @HttpCode(200)
  token(@Body() body: ServiceTokenDto): Promise<ServiceTokenResponse> {
    return this.auth.serviceToken(body.clientId, body.clientSecret);
  }

  @Public()
  @Get('.well-known/jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  jwks(): { keys: PublicJwk[] } {
    return { keys: [this.keys.publicJwk] };
  }
}
