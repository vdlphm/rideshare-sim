import type { Vehicle } from '@rideshare/contracts';
import type { Account } from './bot-client';

const MAKES: [string, string][] = [
  ['Toyota', 'Prius'],
  ['Honda', 'Civic'],
  ['Ford', 'Fusion'],
  ['Tesla', 'Model 3'],
  ['Nissan', 'Leaf'],
  ['Subaru', 'Outback'],
  ['Hyundai', 'Elantra'],
  ['Chevrolet', 'Bolt'],
];
const COLORS = ['white', 'black', 'silver', 'blue', 'red', 'gray', 'green'];

export const pad = (n: number): string => String(n).padStart(3, '0');

export const driverEmail = (n: number): string => `driver-${pad(n)}@sim.local`;
export const riderEmail = (n: number): string => `rider-${pad(n)}@sim.local`;

/** Deterministic vehicle per driver number: same account always re-registers identically. */
export function vehicleFor(n: number): Vehicle {
  const [make, model] = MAKES[n % MAKES.length];
  return { make, model, color: COLORS[(n * 3) % COLORS.length], plate: `SIM-${pad(n)}` };
}

export const driverAccount = (n: number, password: string): Account => ({
  email: driverEmail(n),
  password,
  name: `Sim Driver ${pad(n)}`,
  role: 'driver',
  vehicle: vehicleFor(n),
});

export const riderAccount = (n: number, password: string): Account => ({
  email: riderEmail(n),
  password,
  name: `Sim Rider ${pad(n)}`,
  role: 'rider',
});
