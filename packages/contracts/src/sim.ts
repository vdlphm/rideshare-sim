import { z } from 'zod';
import { LatLngSchema, SimTimeSchema } from './common';

export const SimConfigSchema = z
  .object({
    driverCount: z.number().int().min(0).max(500),
    spawnIntervalS: z.number().positive(),
    speed: z.number().min(0).max(10),
    paused: z.boolean(),
    acceptProbability: z.number().min(0).max(1),
  })
  .strict();
export type SimConfig = z.infer<typeof SimConfigSchema>;

export const SimConfigUpdateSchema = SimConfigSchema.partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type SimConfigUpdate = z.infer<typeof SimConfigUpdateSchema>;

export const ClockStateSchema = z
  .object({ simTime: SimTimeSchema, speed: z.number().min(0).max(10), paused: z.boolean() })
  .strict();
export type ClockState = z.infer<typeof ClockStateSchema>;

export const AddRiderRequestSchema = z
  .object({ pickup: LatLngSchema, dropoff: LatLngSchema })
  .strict();
export type AddRiderRequest = z.infer<typeof AddRiderRequestSchema>;
