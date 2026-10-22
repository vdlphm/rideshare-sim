import { z } from 'zod';
import { RoleSchema, UuidSchema } from './common';

const PhoneSchema = z.string().regex(/^\+[1-9]\d{1,14}$/, 'phone must be E.164');

export const VehicleSchema = z
  .object({
    make: z.string().min(1),
    model: z.string().min(1),
    color: z.string().min(1),
    plate: z.string().min(1),
  })
  .strict();
export type Vehicle = z.infer<typeof VehicleSchema>;

const registerBase = {
  email: z.email(),
  password: z.string().min(8),
  name: z.string().min(1),
  phone: PhoneSchema.optional(),
};

export const RegisterRiderRequestSchema = z
  .object({ ...registerBase, role: z.literal('rider') })
  .strict();
export const RegisterDriverRequestSchema = z
  .object({ ...registerBase, role: z.literal('driver'), vehicle: VehicleSchema })
  .strict();
export const RegisterRequestSchema = z.discriminatedUnion('role', [
  RegisterRiderRequestSchema,
  RegisterDriverRequestSchema,
]);
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z
  .object({ email: z.email(), password: z.string().min(1) })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const TokenPairSchema = z
  .object({ accessToken: z.string().min(1), refreshToken: z.string().min(1) })
  .strict();
export type TokenPair = z.infer<typeof TokenPairSchema>;

export const RefreshRequestSchema = z.object({ refreshToken: z.string().min(1) }).strict();
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const ServiceTokenRequestSchema = z
  .object({ clientId: z.string().min(1), clientSecret: z.string().min(1) })
  .strict();
export type ServiceTokenRequest = z.infer<typeof ServiceTokenRequestSchema>;

export const ServiceTokenResponseSchema = z
  .object({ accessToken: z.string().min(1), expiresIn: z.number().int().positive() })
  .strict();
export type ServiceTokenResponse = z.infer<typeof ServiceTokenResponseSchema>;

export const UserMeSchema = z.object({
  id: UuidSchema,
  email: z.email(),
  name: z.string(),
  phone: PhoneSchema.nullable().optional(),
  role: RoleSchema,
  vehicle: VehicleSchema.nullable().optional(),
});
export type UserMe = z.infer<typeof UserMeSchema>;

export const UpdateMeRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    phone: PhoneSchema.optional(),
    vehicle: VehicleSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type UpdateMeRequest = z.infer<typeof UpdateMeRequestSchema>;

export const UserDisplaySchema = z.object({
  id: UuidSchema,
  name: z.string(),
  role: RoleSchema,
  vehicle: VehicleSchema.nullable().optional(),
});
export type UserDisplay = z.infer<typeof UserDisplaySchema>;

export const UsersBatchRequestSchema = z
  .object({ ids: z.array(UuidSchema).min(1).max(500) })
  .strict();
export type UsersBatchRequest = z.infer<typeof UsersBatchRequestSchema>;

export const JwtClaimsSchema = z.object({
  /** User UUID, or the service name for service tokens. */
  sub: z.union([UuidSchema, z.string().min(1)]),
  role: RoleSchema,
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});
export type JwtClaims = z.infer<typeof JwtClaimsSchema>;
