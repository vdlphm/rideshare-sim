import { z } from 'zod';
import { DriverStateSchema } from './driver';
import { RiderPositionSchema } from './rider';
import { BotsSummarySchema, ClockStateSchema, SimConfigSchema } from './sim';
import { TripSchema, TripStatsSchema } from './trip';
import { UserDisplaySchema } from './user';

/**
 * Admin live-view WebSocket (gateway `/ws?token=<admin access token>`), server → client only.
 *
 * On connect the gateway sends one `snapshot`, then a `diff` per poll tick (~250 ms) when
 * something changed. Clients apply diffs in order: upsert by id, then remove ids.
 *
 * Trips: active and REQUESTED trips, plus trips that ended within the last
 * `WS_ENDED_TRIP_RETENTION_MS` (so the UI can show completion briefly); ended trips are then
 * removed. `users` carries display info (name, vehicle) for drivers/riders the client may show.
 *
 * Close codes: 4401 missing/invalid/expired token (client refreshes and reconnects),
 * 4403 not an admin.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401;
export const WS_CLOSE_FORBIDDEN = 4403;
export const WS_ENDED_TRIP_RETENTION_MS = 10_000;

const SimStateSchema = z.object({
  clock: ClockStateSchema,
  config: SimConfigSchema,
  bots: BotsSummarySchema,
});

function collectionDiff<T extends z.ZodTypeAny>(item: T) {
  return z.object({ upsert: z.array(item), remove: z.array(z.string()) });
}

export const WsSnapshotSchema = SimStateSchema.extend({
  type: z.literal('snapshot'),
  /** Gateway real time (epoch ms) when the frame was built. */
  at: z.number(),
  drivers: z.array(DriverStateSchema),
  riders: z.array(RiderPositionSchema),
  trips: z.array(TripSchema),
  stats: TripStatsSchema,
  users: z.array(UserDisplaySchema),
});
export type WsSnapshot = z.infer<typeof WsSnapshotSchema>;

export const WsDiffSchema = z.object({
  type: z.literal('diff'),
  at: z.number(),
  /** Present only when changed. */
  clock: ClockStateSchema.optional(),
  config: SimConfigSchema.optional(),
  bots: BotsSummarySchema.optional(),
  stats: TripStatsSchema.optional(),
  drivers: collectionDiff(DriverStateSchema),
  riders: collectionDiff(RiderPositionSchema),
  trips: collectionDiff(TripSchema),
  /** Display info for newly referenced users only. */
  users: z.array(UserDisplaySchema),
});
export type WsDiff = z.infer<typeof WsDiffSchema>;

export const WsServerMessageSchema = z.discriminatedUnion('type', [WsSnapshotSchema, WsDiffSchema]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
