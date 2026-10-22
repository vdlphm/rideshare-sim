import { Injectable } from '@nestjs/common';
import { InjectDb, type Db } from '@rideshare/common';
import { eq } from 'drizzle-orm';
import { serviceClients } from '../db/schema';

export interface ServiceClientRecord {
  clientId: string;
  secretHash: string;
  name: string;
}

export abstract class ServiceClientsRepository {
  abstract find(clientId: string): Promise<ServiceClientRecord | undefined>;
  abstract upsert(client: ServiceClientRecord): Promise<void>;
}

@Injectable()
export class DrizzleServiceClientsRepository extends ServiceClientsRepository {
  constructor(@InjectDb() private readonly db: Db) {
    super();
  }

  async find(clientId: string): Promise<ServiceClientRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(serviceClients)
      .where(eq(serviceClients.clientId, clientId));
    return row;
  }

  async upsert(client: ServiceClientRecord): Promise<void> {
    await this.db
      .insert(serviceClients)
      .values(client)
      .onConflictDoUpdate({
        target: serviceClients.clientId,
        set: { secretHash: client.secretHash, name: client.name },
      });
  }
}
