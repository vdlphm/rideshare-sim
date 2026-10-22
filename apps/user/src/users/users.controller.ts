import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '@rideshare/common';
import { RegisterRequestSchema, type RegisterRequest } from '@rideshare/contracts';
import { ZodValidationPipe } from 'nestjs-zod';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Public()
  @Post()
  register(
    // A discriminated union can't be a DTO class, so the pipe takes the schema directly.
    @Body(new ZodValidationPipe(RegisterRequestSchema)) body: RegisterRequest,
  ): Promise<{ userId: string }> {
    return this.users.register(body);
  }
}
