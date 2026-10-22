import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CurrentUser, Public, Roles, type AuthUser } from '@rideshare/common';
import {
  RegisterRequestSchema,
  UpdateMeRequestSchema,
  UsersBatchRequestSchema,
  type RegisterRequest,
  type UpdateMeRequest,
  type UserDisplay,
  type UserMe,
  type UsersBatchRequest,
} from '@rideshare/contracts';
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

  // `me` routes are declared before `:id` so they are not captured by it.
  @Roles('rider', 'driver', 'admin')
  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<UserMe> {
    return this.users.getMe(user.id);
  }

  @Roles('rider', 'driver', 'admin')
  @Patch('me')
  updateMe(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateMeRequestSchema)) body: UpdateMeRequest,
  ): Promise<UserMe> {
    return this.users.updateMe(user, body);
  }

  @Roles('admin')
  @Get(':id')
  byId(@Param('id', new ParseUUIDPipe()) id: string): Promise<UserMe> {
    return this.users.getById(id);
  }
}

/** Service-to-service endpoints; not exposed through the gateway. */
@Controller('internal/users')
export class InternalUsersController {
  constructor(private readonly users: UsersService) {}

  @Roles('service')
  @Post('batch')
  @HttpCode(200) // a read, not a create
  batch(
    @Body(new ZodValidationPipe(UsersBatchRequestSchema)) body: UsersBatchRequest,
  ): Promise<UserDisplay[]> {
    return this.users.batchDisplay(body.ids);
  }
}
