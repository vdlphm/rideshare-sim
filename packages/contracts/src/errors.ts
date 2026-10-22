import { z } from 'zod';

export const ErrorResponseSchema = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.union([z.string(), z.array(z.string())]),
  correlationId: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
