import { ConflictException, Injectable } from '@nestjs/common';
import type { RegisterRequest } from '@rideshare/contracts';
import bcrypt from 'bcryptjs';
import { normalizeEmail } from '../auth/email';
import { uniqueViolationConstraint } from './pg-errors';
import { UsersRepository } from './users.repository';

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
}
