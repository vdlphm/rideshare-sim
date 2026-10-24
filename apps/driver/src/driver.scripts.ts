/**
 * Every driver state transition is ONE Lua script so the hash, the GEO set and the online set
 * change atomically (Redis runs a script without interleaving other commands).
 *
 * KEYS (auto-prefixed by the client): [1] state hash, [2] GEO set of available drivers,
 * [3] online set. ARGV (not prefixed): op, driverId, nowMs, staleAfterMs, then op-specific args.
 *
 * Reply: [code, status, tripId, lat, lng, heading, ts] with every field a string; `code` is
 * OK | NOT_FOUND | NOT_ONLINE | ON_TRIP (conflict) | SWEPT | FRESH | SKIPPED.
 *
 * Ops:
 *   online   lat lng          AVAILABLE + position + GEO + online set; ON_TRIP keeps its status
 *   offline                   OFFLINE, out of GEO + online; refused with ON_TRIP while ON_TRIP
 *   location lat lng heading  position/ts; GEO member only while AVAILABLE; needs a known, non-OFFLINE driver
 *   status   status tripId    trip-driven change: ON_TRIP leaves GEO; AVAILABLE re-enters GEO if the
 *                             position is fresh; OFFLINE leaves GEO + online. Idempotent.
 *   sweep                     OFFLINE if AVAILABLE and ts older than staleAfterMs; ON_TRIP is never touched
 */
export const DRIVER_TRANSITION_LUA = `
local state, geo, online = KEYS[1], KEYS[2], KEYS[3]
local op, id, now, stale = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])

local function snapshot(code)
  local h = redis.call('HMGET', state, 'status', 'tripId', 'lat', 'lng', 'heading', 'ts')
  return { code, h[1] or '', h[2] or '', h[3] or '', h[4] or '', h[5] or '', h[6] or '' }
end

local function goOffline()
  redis.call('HSET', state, 'status', 'OFFLINE', 'tripId', '')
  redis.call('ZREM', geo, id)
  redis.call('SREM', online, id)
end

local status = redis.call('HGET', state, 'status')

if op == 'online' then
  if status == 'ON_TRIP' then
    redis.call('HSET', state, 'lat', ARGV[5], 'lng', ARGV[6], 'ts', ARGV[3])
    redis.call('SADD', online, id)
    return snapshot('OK')
  end
  redis.call('HSET', state, 'status', 'AVAILABLE', 'tripId', '', 'lat', ARGV[5], 'lng', ARGV[6], 'ts', ARGV[3])
  redis.call('HSETNX', state, 'heading', '0')
  redis.call('GEOADD', geo, ARGV[6], ARGV[5], id)
  redis.call('SADD', online, id)
  return snapshot('OK')
end

if not status then
  return { 'NOT_FOUND', '', '', '', '', '', '' }
end

if op == 'offline' then
  if status == 'ON_TRIP' then return snapshot('ON_TRIP') end
  goOffline()
  return snapshot('OK')
end

if op == 'location' then
  if status == 'OFFLINE' then return snapshot('NOT_ONLINE') end
  redis.call('HSET', state, 'lat', ARGV[5], 'lng', ARGV[6], 'heading', ARGV[7], 'ts', ARGV[3])
  if status == 'AVAILABLE' then
    redis.call('GEOADD', geo, ARGV[6], ARGV[5], id)
  end
  return snapshot('OK')
end

if op == 'status' then
  local target = ARGV[5]
  if target == 'ON_TRIP' then
    redis.call('HSET', state, 'status', 'ON_TRIP', 'tripId', ARGV[6])
    redis.call('ZREM', geo, id)
    redis.call('SADD', online, id)
  elseif target == 'AVAILABLE' then
    if status == 'OFFLINE' then return snapshot('OK') end
    redis.call('HSET', state, 'status', 'AVAILABLE', 'tripId', '')
    local ts = tonumber(redis.call('HGET', state, 'ts'))
    if ts and now - ts <= stale then
      redis.call('GEOADD', geo, redis.call('HGET', state, 'lng'), redis.call('HGET', state, 'lat'), id)
    else
      redis.call('ZREM', geo, id)
    end
    redis.call('SADD', online, id)
  else
    goOffline()
  end
  return snapshot('OK')
end

if op == 'sweep' then
  if status == 'ON_TRIP' then return snapshot('ON_TRIP') end
  if status == 'AVAILABLE' then
    local ts = tonumber(redis.call('HGET', state, 'ts'))
    if ts and now - ts <= stale then return snapshot('FRESH') end
    goOffline()
    return snapshot('SWEPT')
  end
  -- OFFLINE but still listed (should not happen): repair.
  redis.call('ZREM', geo, id)
  redis.call('SREM', online, id)
  return snapshot('SKIPPED')
end

return redis.error_reply('unknown op ' .. op)
`;
