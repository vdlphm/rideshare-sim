import {
  GoneException,
  NotFoundException,
  ConflictException,
  BadGatewayException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DROPOFF, PICKUP, setup } from './support/fakes';

const tripId = () => randomUUID();

describe('candidate selection', () => {
  it('ranks by ETA, not by distance', async () => {
    const s = setup();
    const near = s.add(200, 300); // closest but slow
    const far = s.add(900, 60); // farther but fast
    const t = tripId();
    await s.start(t);
    const [offer] = s.pending(t);
    expect(offer!.driverId).toBe(far.driverId);
    expect(offer!.etaS).toBe(60);
    expect(offer!.driverPosition).toEqual({ lat: far.lat, lng: far.lng });
    expect(offer!.pickup).toEqual(PICKUP);
    expect(offer!.dropoff).toEqual(DROPOFF);
    expect(s.pending(t).some((o) => o.driverId === near.driverId)).toBe(false);
  });

  it('asks for the 10 closest drivers', async () => {
    const s = setup();
    s.add(100, 10);
    await s.start(tripId());
    expect(s.drivers.calls[0]).toEqual({ radiusM: 1000, limit: 10 });
  });

  it('drops candidates the router cannot reach', async () => {
    const s = setup();
    s.add(100, null);
    const ok = s.add(500, 200);
    const t = tripId();
    await s.start(t);
    expect(s.pending(t)[0]!.driverId).toBe(ok.driverId);
  });

  it('excludes drivers in the declined set', async () => {
    const s = setup();
    const a = s.add(100, 10);
    const b = s.add(200, 20);
    const t = tripId();
    await s.locks.addDeclined(t, a.driverId);
    await s.start(t);
    expect(s.pending(t)[0]!.driverId).toBe(b.driverId);
  });

  it('skips drivers locked by another trip and takes the next best', async () => {
    const s = setup();
    const a = s.add(100, 10);
    const b = s.add(200, 20);
    await s.locks.acquire(a.driverId, 'other-trip');
    const t = tripId();
    await s.start(t);
    expect(s.pending(t)[0]!.driverId).toBe(b.driverId);
    expect(s.locks.held.get(a.driverId)).toBe('other-trip');
    expect(s.locks.held.get(b.driverId)).toBe(t);
  });

  it('never gives one driver two pending offers (two trips, one driver)', async () => {
    const s = setup();
    const d = s.add(100, 10);
    const t1 = tripId();
    const t2 = tripId();
    await Promise.all([s.start(t1), s.start(t2)]);
    const all = [...s.repo.offers.values()].filter((o) => o.driverId === d.driverId);
    expect(all).toHaveLength(1);
  });

  it('does not offer when the driver or routing service is down; retries later', async () => {
    const s = setup();
    s.add(100, 10);
    const t = tripId();
    s.drivers.failing = true;
    await s.start(t);
    expect(s.pending(t)).toHaveLength(0);
    s.drivers.failing = false;
    s.routing.failing = true;
    await s.engine.step(t);
    expect(s.pending(t)).toHaveLength(0);
    s.routing.failing = false;
    await s.engine.sweep();
    expect(s.pending(t)).toHaveLength(1);
    expect((await s.repo.getJob(t))!.status).toBe('ACTIVE');
  });
});

describe('radius widening', () => {
  it('widens 1000 -> 2000 -> 4000 until a driver is found', async () => {
    const s = setup();
    const d = s.add(3500, 100);
    const t = tripId();
    await s.start(t);
    expect(s.drivers.calls.map((c) => c.radiusM)).toEqual([1000, 2000, 4000]);
    expect(s.pending(t)[0]!.driverId).toBe(d.driverId);
    expect(await s.repo.getJob(t)).toMatchObject({ attempt: 2, radiusM: 4000 });
  });

  it('stays at the widest radius and keeps retrying while nobody is around', async () => {
    const s = setup();
    const t = tripId();
    await s.start(t);
    expect(await s.repo.getJob(t)).toMatchObject({ status: 'ACTIVE', attempt: 2, radiusM: 4000 });
    s.drivers.calls.length = 0;
    await s.engine.sweep();
    expect(s.drivers.calls.map((c) => c.radiusM)).toEqual([4000]);
    s.add(3900, 50); // a driver appears later
    await s.engine.sweep();
    expect(s.pending(t)).toHaveLength(1);
  });

  it('throttles idle retries per job by real time', async () => {
    let real = 0;
    const s = setup({ idleRetryMs: 1000, realNow: () => real });
    const t = tripId();
    await s.start(t);
    await s.engine.sweep(); // first idle step
    const n = s.drivers.calls.length;
    real = 500;
    await s.engine.sweep();
    expect(s.drivers.calls.length).toBe(n);
    real = 1500;
    await s.engine.sweep();
    expect(s.drivers.calls.length).toBeGreaterThan(n);
  });
});

describe('giving up', () => {
  it('reports no-drivers and marks the job FAILED after 60 sim seconds', async () => {
    const s = setup();
    const t = tripId();
    await s.start(t);
    s.clock.t += 60_000; // exactly at the limit: not yet
    await s.engine.sweep();
    expect(s.trip.noDriversCalls).toEqual([]);
    s.clock.t += 1;
    await s.engine.sweep();
    expect(s.trip.noDriversCalls).toEqual([t]);
    expect((await s.repo.getJob(t))!.status).toBe('FAILED');
    await s.engine.sweep();
    expect(s.trip.noDriversCalls).toEqual([t]); // not again
  });

  it('retries the no-drivers call while the trip service is unreachable', async () => {
    const s = setup();
    const t = tripId();
    await s.start(t);
    s.clock.t += 61_000;
    s.trip.noDriversOutcome = 'unreachable';
    await s.engine.sweep();
    expect((await s.repo.getJob(t))!.status).toBe('ACTIVE');
    s.trip.noDriversOutcome = 'ok';
    await s.engine.sweep();
    expect((await s.repo.getJob(t))!.status).toBe('FAILED');
  });

  it('closes the job without failing it when the trip is already gone', async () => {
    const s = setup();
    const t = tripId();
    await s.start(t);
    s.clock.t += 61_000;
    s.trip.noDriversOutcome = 'trip-gone';
    await s.engine.sweep();
    expect((await s.repo.getJob(t))!.status).toBe('DONE');
  });

  it('measures the limit in sim time: real time passing changes nothing', async () => {
    const s = setup({ realNow: () => Date.now() + 10 * 60_000 });
    const t = tripId();
    await s.start(t);
    await s.engine.sweep();
    expect(s.trip.noDriversCalls).toEqual([]);
  });
});

describe('offer expiry (sim time)', () => {
  it('expires at expiresSim, declines the driver, frees the lock, offers the next', async () => {
    const s = setup();
    const a = s.add(100, 10);
    const b = s.add(200, 20);
    const t = tripId();
    await s.start(t);
    const first = s.pending(t)[0]!;
    expect(first.driverId).toBe(a.driverId);
    expect(first.expiresSim).toBe(s.clock.t + 15_000);

    s.clock.t += 14_999;
    await s.engine.sweep();
    expect(s.repo.offers.get(first.id)!.status).toBe('PENDING');

    s.clock.t += 1;
    const stats = await s.engine.sweep();
    expect(stats.expired).toBe(1);
    expect(s.repo.offers.get(first.id)).toMatchObject({
      status: 'EXPIRED',
      resolvedSim: s.clock.t,
    });
    expect(s.locks.held.has(a.driverId)).toBe(false);
    expect((await s.locks.declined(t)).has(a.driverId)).toBe(true);
    expect(s.pending(t)[0]!.driverId).toBe(b.driverId);
    expect(s.pending(t)[0]!.attempt).toBe(2);
  });

  it('never expires while the clock is paused, and keeps refreshing the lock', async () => {
    const s = setup();
    const a = s.add(100, 10);
    const t = tripId();
    await s.start(t);
    for (let i = 0; i < 5; i++) await s.engine.sweep(); // clock frozen
    expect(s.pending(t)[0]!.driverId).toBe(a.driverId);
    expect(s.locks.refreshed).toHaveLength(5);
    s.locks.held.delete(a.driverId); // lock lapsed (e.g. Redis hiccup)
    await s.engine.sweep();
    expect(s.locks.held.get(a.driverId)).toBe(t); // re-established by the refresh
  });

  it('does not step a job that has a pending offer', async () => {
    const s = setup();
    s.add(100, 10);
    s.add(200, 20);
    const t = tripId();
    await s.start(t);
    await s.engine.sweep();
    await s.engine.sweep();
    expect(s.pending(t)).toHaveLength(1);
  });
});

describe('/internal/match semantics', () => {
  it('is idempotent for an ACTIVE job', async () => {
    const s = setup();
    s.add(100, 10);
    const t = tripId();
    expect(await s.engine.requestMatch({ tripId: t, pickup: PICKUP, dropoff: DROPOFF })).toBe(
      'started',
    );
    expect(await s.engine.requestMatch({ tripId: t, pickup: PICKUP, dropoff: DROPOFF })).toBe(
      'noop',
    );
    await s.engine.step(t);
    expect(s.repo.jobs.size).toBe(1);
    expect(s.pending(t)).toHaveLength(1);
  });

  it('runs matching in the background after returning', async () => {
    const s = setup();
    s.add(100, 10);
    const t = tripId();
    await s.engine.requestMatch({ tripId: t, pickup: PICKUP, dropoff: DROPOFF });
    await s.engine.step(t); // queued behind the background step
    expect(s.pending(t)).toHaveLength(1);
  });

  it('restarts a DONE job (attempt 0, fresh start time) and keeps the declined set', async () => {
    const s = setup();
    const a = s.add(100, 10);
    const b = s.add(200, 20);
    const t = tripId();
    await s.start(t);
    const offer = s.pending(t)[0]!;
    await s.engine.accept(offer.id, a.driverId); // job DONE
    expect((await s.repo.getJob(t))!.status).toBe('DONE');
    await s.locks.addDeclined(t, a.driverId); // e.g. trip unassigned because driver went offline

    s.clock.t += 120_000;
    expect(await s.engine.requestMatch({ tripId: t, pickup: PICKUP, dropoff: DROPOFF })).toBe(
      'restarted',
    );
    await s.engine.step(t);
    expect(await s.repo.getJob(t)).toMatchObject({ status: 'ACTIVE', startedSim: s.clock.t });
    expect(s.pending(t)[0]!.driverId).toBe(b.driverId);
  });

  it('restarts a FAILED job', async () => {
    const s = setup();
    const t = tripId();
    await s.start(t);
    s.clock.t += 61_000;
    await s.engine.sweep();
    expect((await s.repo.getJob(t))!.status).toBe('FAILED');
    s.add(100, 10);
    expect(await s.engine.requestMatch({ tripId: t, pickup: PICKUP, dropoff: DROPOFF })).toBe(
      'restarted',
    );
    await s.engine.step(t);
    expect(s.pending(t)).toHaveLength(1);
  });
});

describe('accept', () => {
  async function offered() {
    const s = setup();
    const a = s.add(100, 10);
    const b = s.add(200, 20);
    const t = tripId();
    await s.start(t);
    return { s, a, b, t, offer: s.pending(t)[0]! };
  }

  it('assigns, then marks ACCEPTED, job DONE and releases the lock', async () => {
    const { s, a, t, offer } = await offered();
    await expect(s.engine.accept(offer.id, a.driverId)).resolves.toEqual({ tripId: t });
    expect(s.trip.assigns).toEqual([
      { tripId: t, driverId: a.driverId, offerId: offer.id, driverPosition: offer.driverPosition },
    ]);
    expect(s.repo.offers.get(offer.id)!.status).toBe('ACCEPTED');
    expect((await s.repo.getJob(t))!.status).toBe('DONE');
    expect(s.locks.held.has(a.driverId)).toBe(false);
  });

  it('404 for another driver, whose offer stays pending', async () => {
    const { s, b, offer } = await offered();
    await expect(s.engine.accept(offer.id, b.driverId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.engine.accept(randomUUID(), b.driverId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s.repo.offers.get(offer.id)!.status).toBe('PENDING');
    expect(s.trip.assigns).toHaveLength(0);
  });

  it('410 when expired (even before the sweeper ran) and when already accepted', async () => {
    const { s, a, offer } = await offered();
    s.clock.t = offer.expiresSim;
    await expect(s.engine.accept(offer.id, a.driverId)).rejects.toBeInstanceOf(GoneException);

    const second = await offered();
    await second.s.engine.accept(second.offer.id, second.a.driverId);
    await expect(second.s.engine.accept(second.offer.id, second.a.driverId)).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(second.s.trip.assigns).toHaveLength(1);
  });

  it('double-click: concurrent accepts assign once', async () => {
    const { s, a, t, offer } = await offered();
    const results = await Promise.allSettled([
      s.engine.accept(offer.id, a.driverId),
      s.engine.accept(offer.id, a.driverId),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(s.trip.assigns).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<unknown>).value,
    ).toEqual({ tripId: t });
  });

  it('trip 409 status: offer EXPIRED, job DONE, no more steps, 409', async () => {
    const { s, a, t, offer } = await offered();
    s.trip.assignOutcome = 'trip-gone';
    await expect(s.engine.accept(offer.id, a.driverId)).rejects.toThrow('trip no longer available');
    expect(s.repo.offers.get(offer.id)!.status).toBe('EXPIRED');
    expect((await s.repo.getJob(t))!.status).toBe('DONE');
    expect(s.locks.held.has(a.driverId)).toBe(false);
    await s.engine.step(t);
    await s.engine.sweep();
    expect(s.pending(t)).toHaveLength(0);
  });

  it.each(['driver-busy', 'conflict'] as const)(
    'trip %s: offer EXPIRED, driver declined, next candidate offered, 409',
    async (outcome) => {
      const { s, a, b, t, offer } = await offered();
      s.trip.assignOutcome = outcome;
      await expect(s.engine.accept(offer.id, a.driverId)).rejects.toBeInstanceOf(ConflictException);
      expect(s.repo.offers.get(offer.id)!.status).toBe('EXPIRED');
      expect((await s.locks.declined(t)).has(a.driverId)).toBe(true);
      expect(s.locks.held.has(a.driverId)).toBe(false);
      await s.engine.step(t); // let the background follow-up finish
      expect(s.pending(t)[0]!.driverId).toBe(b.driverId);
      expect((await s.repo.getJob(t))!.status).toBe('ACTIVE');
    },
  );

  it('trip unreachable: 502 and the offer stays pending (driver can retry)', async () => {
    const { s, a, offer } = await offered();
    s.trip.assignOutcome = 'unreachable';
    await expect(s.engine.accept(offer.id, a.driverId)).rejects.toBeInstanceOf(BadGatewayException);
    expect(s.repo.offers.get(offer.id)!.status).toBe('PENDING');
    expect(s.locks.held.get(a.driverId)).toBeDefined();
    s.trip.assignOutcome = 'ok';
    await expect(s.engine.accept(offer.id, a.driverId)).resolves.toBeDefined();
  });
});

describe('decline', () => {
  it('moves to the next candidate and never re-offers to the decliner', async () => {
    const s = setup();
    const a = s.add(100, 10);
    const b = s.add(200, 20);
    const t = tripId();
    await s.start(t);
    const offer = s.pending(t)[0]!;
    await s.engine.decline(offer.id, a.driverId);
    await s.engine.step(t);
    expect(s.repo.offers.get(offer.id)!.status).toBe('DECLINED');
    expect(s.locks.held.has(a.driverId)).toBe(false);
    expect(s.pending(t)[0]!.driverId).toBe(b.driverId);
    await s.engine.decline(s.pending(t)[0]!.id, b.driverId);
    await s.engine.step(t);
    expect(s.pending(t)).toHaveLength(0); // both declined, nobody left
  });

  it('404 for another driver, 410 when not pending', async () => {
    const s = setup();
    const a = s.add(100, 10);
    const b = s.add(200, 20);
    const t = tripId();
    await s.start(t);
    const offer = s.pending(t)[0]!;
    await expect(s.engine.decline(offer.id, b.driverId)).rejects.toBeInstanceOf(NotFoundException);
    await s.engine.decline(offer.id, a.driverId);
    await expect(s.engine.decline(offer.id, a.driverId)).rejects.toBeInstanceOf(GoneException);
  });
});

describe('locks', () => {
  it('are released only by the owning trip', async () => {
    const s = setup();
    await s.locks.acquire('d1', 'trip-a');
    await s.locks.release('d1', 'trip-b');
    expect(s.locks.held.get('d1')).toBe('trip-a');
    await s.locks.release('d1', 'trip-a');
    expect(s.locks.held.has('d1')).toBe(false);
  });

  it('expiring an old offer does not free a lock now held by another trip', async () => {
    const s = setup();
    const a = s.add(100, 10);
    const t = tripId();
    await s.start(t);
    s.locks.held.set(a.driverId, 'someone-else'); // our lock lapsed and was taken
    s.clock.t += 15_000;
    await s.engine.sweep();
    expect(s.locks.held.get(a.driverId)).toBe('someone-else');
  });
});

describe('currentOffer', () => {
  it('returns only the pending, unexpired offer', async () => {
    const s = setup();
    const a = s.add(100, 10);
    const t = tripId();
    await s.start(t);
    expect((await s.engine.currentOffer(a.driverId))!.tripId).toBe(t);
    expect(await s.engine.currentOffer(randomUUID())).toBeNull();
    s.clock.t += 15_000;
    expect(await s.engine.currentOffer(a.driverId)).toBeNull();
  });
});
