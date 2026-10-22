import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectConfig } from '@rideshare/common';
import bcrypt from 'bcryptjs';
import { normalizeEmail } from '../auth/email';
import { ServiceClientsRepository } from '../auth/service-clients.repository';
import { SERVICE_CLIENTS, type UserEnv } from '../config';
import { BCRYPT_COST } from '../users/users.service';
import { UsersRepository } from '../users/users.repository';

/** Idempotent startup seeding: the admin account and one client row per internal caller. */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    @InjectConfig() private readonly cfg: UserEnv,
    private readonly users: UsersRepository,
    private readonly clients: ServiceClientsRepository,
  ) {}

  // After every module's onModuleInit, i.e. after migrations have run.
  async onApplicationBootstrap(): Promise<void> {
    await this.seed();
  }

  async seed(): Promise<void> {
    await this.seedAdmin();
    await this.seedClients();
  }

  private async seedAdmin(): Promise<void> {
    const email = normalizeEmail(this.cfg.ADMIN_EMAIL);
    const existing = await this.users.findByEmail(email);
    if (!existing) {
      await this.users.createAdmin({
        email,
        name: 'Admin',
        passwordHash: await bcrypt.hash(this.cfg.ADMIN_PASSWORD, BCRYPT_COST),
      });
      this.logger.log(`Seeded admin ${email}`);
      return;
    }
    if (existing.role !== 'admin') {
      throw new Error(`ADMIN_EMAIL ${email} belongs to an existing non-admin account`);
    }
    if (!(await bcrypt.compare(this.cfg.ADMIN_PASSWORD, existing.passwordHash))) {
      await this.users.updatePasswordHash(
        existing.id,
        await bcrypt.hash(this.cfg.ADMIN_PASSWORD, BCRYPT_COST),
      );
      this.logger.log('Updated admin password to match ADMIN_PASSWORD');
    }
  }

  private async seedClients(): Promise<void> {
    for (const [clientId, envKey] of SERVICE_CLIENTS) {
      const secret = this.cfg[envKey];
      const existing = await this.clients.find(clientId);
      if (existing && (await bcrypt.compare(secret, existing.secretHash))) continue;
      await this.clients.upsert({
        clientId,
        name: clientId,
        secretHash: await bcrypt.hash(secret, BCRYPT_COST),
      });
      this.logger.log(`${existing ? 'Updated' : 'Seeded'} service client ${clientId}`);
    }
  }
}
