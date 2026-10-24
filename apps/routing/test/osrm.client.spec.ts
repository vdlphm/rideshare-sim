import { BadGatewayException, UnprocessableEntityException } from '@nestjs/common';
import { RouteSchema } from '@rideshare/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { NEEDLE, PIKE, fixture, makeOsrm, type FakeOsrm } from './helpers';

let osrm: FakeOsrm;
afterEach(() => osrm.agent.close());

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('OsrmClient.route', () => {
  it('maps OSRM output to a Route whose durations match the geometry and sum to durationS', async () => {
    osrm = makeOsrm();
    osrm.reply('/route/v1/driving/', 200, fixture('route-ok'));
    const route = await osrm.client.route(PIKE, NEEDLE);

    expect(RouteSchema.safeParse(route).success).toBe(true);
    expect(route.distanceM).toBeCloseTo(1638.2, 1);
    expect(route.durationS).toBeCloseTo(236.7, 1);
    expect(route.durations).toHaveLength(route.geometry.length - 1);
    expect(sum(route.durations)).toBeCloseTo(route.durationS, 6);
    // lng,lat order in both the OSRM path and the geometry
    expect(osrm.calls[0]).toContain('/route/v1/driving/-122.3422,47.6097;-122.3493,47.6205?');
    expect(osrm.calls[0]).toContain('overview=full');
    expect(osrm.calls[0]).toContain('geometries=geojson');
    expect(osrm.calls[0]).toContain('annotations=duration');
  });

  it('keeps the relative shape of the per-segment annotation when rescaling', async () => {
    osrm = makeOsrm();
    const body = fixture('route-ok');
    osrm.reply('/route/v1/driving/', 200, body);
    const route = await osrm.client.route(PIKE, NEEDLE);
    const ann: number[] = body.routes[0].legs[0].annotation.duration;
    const k = route.durationS / sum(ann);
    route.durations.forEach((d, i) => expect(d).toBeCloseTo(ann[i]! * k, 9));
  });

  it('falls back to length-proportional durations when the annotation does not fit', async () => {
    osrm = makeOsrm();
    const body = fixture('route-ok');
    body.routes[0].legs[0].annotation.duration = [1, 2, 3];
    osrm.reply('/route/v1/driving/', 200, body);
    const route = await osrm.client.route(PIKE, NEEDLE);
    expect(route.durations).toHaveLength(route.geometry.length - 1);
    expect(sum(route.durations)).toBeCloseTo(route.durationS, 6);
    expect(RouteSchema.safeParse(route).success).toBe(true);
  });

  it('maps NoRoute (HTTP 200) to 422', async () => {
    osrm = makeOsrm();
    osrm.reply('/route/v1/driving/', 200, fixture('no-route'));
    const err = await osrm.client.route(PIKE, NEEDLE).catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.message).toContain('NoRoute');
  });

  it.each(['NoSegment', 'InvalidQuery'])('maps %s on HTTP 400 to 422', async (code) => {
    osrm = makeOsrm();
    osrm.reply('/route/v1/driving/', 400, { code, message: 'nope' });
    await expect(osrm.client.route(PIKE, NEEDLE)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('maps 5xx and malformed bodies to 502', async () => {
    osrm = makeOsrm();
    osrm.reply('/route/v1/driving/', 503, 'down');
    await expect(osrm.client.route(PIKE, NEEDLE)).rejects.toBeInstanceOf(BadGatewayException);
    await osrm.agent.close();

    osrm = makeOsrm();
    osrm.reply('/route/v1/driving/', 200, { code: 'Ok', routes: [] });
    await expect(osrm.client.route(PIKE, NEEDLE)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps network errors to 502', async () => {
    osrm = makeOsrm();
    osrm.agent
      .get('http://osrm:5000')
      .intercept({ path: (p: string) => p.startsWith('/route/') })
      .replyWithError(new Error('boom'));
    await expect(osrm.client.route(PIKE, NEEDLE)).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('OsrmClient.table', () => {
  it('returns durations and keeps nulls for unreachable pairs', async () => {
    osrm = makeOsrm();
    osrm.reply('/table/v1/driving/', 200, fixture('table-nulls'));
    const durations = await osrm.client.table([PIKE, NEEDLE], [NEEDLE, PIKE]);
    expect(durations).toEqual([
      [236.7, null],
      [null, 0],
    ]);
    expect(osrm.calls[0]).toContain('sources=0;1&destinations=2;3&annotations=duration');
  });

  it('rejects a table whose shape does not match the request', async () => {
    osrm = makeOsrm();
    osrm.reply('/table/v1/driving/', 200, fixture('table-nulls'));
    await expect(osrm.client.table([PIKE], [NEEDLE])).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('OsrmClient.nearest', () => {
  it('returns the snapped point and distance', async () => {
    osrm = makeOsrm();
    osrm.reply('/nearest/v1/driving/', 200, fixture('nearest-ok'));
    expect(await osrm.client.nearest(PIKE)).toEqual({
      lat: 47.609681,
      lng: -122.342225,
      distanceM: 2.827300801,
    });
    expect(osrm.calls[0]).toBe('/nearest/v1/driving/-122.3422,47.6097?number=1');
  });
});
