import { sql } from 'drizzle-orm';
import { customType } from 'drizzle-orm/pg-core';

/** [lng, lat], GeoJSON order. */
export type Position = [lng: number, lat: number];

/**
 * PostGIS lives in the `postgis` schema and the pool pins `search_path` to the service schema
 * only (the role-level `trip_service, postgis` setting is overridden by the connection
 * option), so every PostGIS reference is schema-qualified.
 */
export const POSTGIS = 'postgis';

const WKB_POINT = 1;
const WKB_LINESTRING = 2;
const EWKB_SRID_FLAG = 0x20000000;

/** Decodes the hex EWKB that node-postgres returns for a `geography` column. */
export function parseEwkbHex(hex: string): { type: number; coords: Position[] } {
  const buf = Buffer.from(hex, 'hex');
  const le = buf.readUInt8(0) === 1;
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = (o: number) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  const rawType = u32(1);
  let offset = 5;
  if (rawType & EWKB_SRID_FLAG) offset += 4;
  const type = rawType & 0xff;
  const readPos = (): Position => {
    const p: Position = [f64(offset), f64(offset + 8)];
    offset += 16;
    return p;
  };
  if (type === WKB_POINT) return { type, coords: [readPos()] };
  if (type === WKB_LINESTRING) {
    const n = u32(offset);
    offset += 4;
    const coords: Position[] = [];
    for (let i = 0; i < n; i++) coords.push(readPos());
    return { type, coords };
  }
  throw new Error(`Unsupported geometry type ${type}`);
}

const ewktPos = ([lng, lat]: Position) => `${lng} ${lat}`;
const fromText = (ewkt: string) => sql`${sql.raw(POSTGIS)}.ST_GeogFromText(${ewkt})`;

/** `geography(Point,4326)` <-> `{ lat, lng }`. */
export const geographyPoint = customType<{
  data: { lat: number; lng: number };
  driverData: string;
}>({
  dataType: () => `${POSTGIS}.geography(Point,4326)`,
  toDriver: (v) => fromText(`SRID=4326;POINT(${v.lng} ${v.lat})`) as unknown as string,
  fromDriver: (hex) => {
    const [lng, lat] = parseEwkbHex(hex).coords[0]!;
    return { lat, lng };
  },
});

/** `geography(LineString,4326)` <-> `[lng, lat][]`. */
export const geographyLineString = customType<{ data: Position[]; driverData: string }>({
  dataType: () => `${POSTGIS}.geography(LineString,4326)`,
  toDriver: (v) =>
    fromText(`SRID=4326;LINESTRING(${v.map(ewktPos).join(',')})`) as unknown as string,
  fromDriver: (hex) => parseEwkbHex(hex).coords,
});
