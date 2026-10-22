import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '@rideshare/common';
import type { RegisterRequest, UpdateMeRequest, UserDisplay, UserMe } from '@rideshare/contracts';
import bcrypt from 'bcryptjs';
import { normalizeEmail } from '../auth/email';
import { uniqueViolationConstraint } from './pg-errors';
import { UsersRepository, type UserProfile } from './users.repository';

export const BCRYPT_COST = 10;

@Injectable()
export class UsersService {
  constructor(private readonly users: UsersRepository) {}

  async register(req: RegisterRequest): Promise<{ userId: string }> {
    const passwordHash = await bcrypt.hash(req.password, BCRYPT_COST);
    try {
      const { id } = await this.users.createWithProfile({
        email: normalizeEmail(req.email),
        passwordHash,
        name: req.name,
        phone: req.phone,
        role: req.role,
        vehicle: req.role === 'driver' ? req.vehicle : undefined,
      });
      return { userId: id };
    } catch (err) {
      // Map the DB's unique violations rather than pre-checking, which would race.
      const constraint = uniqueViolationConstraint(err);
      if (constraint === undefined) throw err;
      if (constraint.includes('plate')) {
        throw new ConflictException('Vehicle plate already registered');
      }
      if (constraint.includes('email')) throw new ConflictException('Email already registered');
      throw new ConflictException('Resource already exists');
    }
  }

  async getMe(userId: string): Promise<UserMe> {
    return this.requireProfile(await this.users.findProfileById(userId));
  }

  /** Admin lookup of any user; same shape as getMe. */
  async getById(id: string): Promise<UserMe> {
    return this.getMe(id);
  }

  async updateMe(user: AuthUser, req: UpdateMeRequest): Promise<UserMe> {
    if (req.vehicle && user.role !== 'driver') {
      throw new BadRequestException('Only drivers can set a vehicle');
    }
    try {
      return this.requireProfile(await this.users.updateProfile(user.id, req));
    } catch (err) {
      if (uniqueViolationConstraint(err) === undefined) throw err;
      throw new ConflictException('Vehicle plate already registered');
    }
  }

  async batchDisplay(ids: string[]): Promise<UserDisplay[]> {
    return this.users.findDisplayByIds([...new Set(ids)]);
  }

  private requireProfile(profile: UserProfile | undefined): UserProfile {
    if (!profile) throw new NotFoundException('User not found');
    return profile;
  }
}
