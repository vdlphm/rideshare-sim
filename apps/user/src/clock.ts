/** Milliseconds since epoch; injectable so tests control time. */
export type Clock = () => number;
export const CLOCK = Symbol('CLOCK');
