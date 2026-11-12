import { describe, expect, it } from 'vitest';
import { IdleProtection } from '../../src/main/core/idle-protection';
import { idleSettingsSchema, type IdleState } from '../../src/shared/idle';

function fixture(minutes: 0 | 5 | 10 = 10) {
  let wall = 1000000,
    monotonic = 0,
    ended = 0;
  const states: IdleState[] = [];
  const guard = new IdleProtection(
    { minutes, notifications: false },
    () => ({ wall, monotonic }),
    (state) => states.push(state),
    () => {
      ended++;
    },
  );
  return {
    guard,
    states,
    ended: () => ended,
    advance: (ms: number) => {
      wall += ms;
      monotonic += ms;
      guard.tick();
    },
    wall: (ms: number) => {
      wall += ms;
      guard.tick();
    },
    mono: (ms: number) => {
      monotonic += ms;
      guard.tick();
    },
  };
}
describe('main-owned idle session deadlines', () => {
  it('ends the session even if publishing the privacy state fails', () => {
    let ended = 0;
    const guard = new IdleProtection(
      { minutes: 10, notifications: false },
      () => ({ wall: 0, monotonic: 0 }),
      () => {
        throw new Error('renderer unavailable');
      },
      () => {
        ended++;
      },
    );
    expect(() => guard.end('manual')).toThrow('renderer unavailable');
    expect(ended).toBe(1);
    expect(guard.snapshot().phase).toBe('shielded');
  });
  it('warns during the last minute, updates seconds and ends exactly once at the deadline', () => {
    const f = fixture();
    f.advance(539000);
    expect(f.guard.snapshot()).toMatchObject({ phase: 'active', seconds: 61 });
    f.advance(1000);
    expect(f.guard.snapshot()).toMatchObject({ phase: 'warning', seconds: 60 });
    f.advance(1000);
    expect(f.guard.snapshot().seconds).toBe(59);
    f.advance(59000);
    expect(f.guard.snapshot()).toMatchObject({ phase: 'shielded', seconds: 0, reason: 'idle' });
    f.advance(1000000);
    f.guard.end('manual');
    expect(f.ended()).toBe(1);
  });
  it('accepts local activity only before warning; Stay active explicitly starts a fresh interval', () => {
    const f = fixture();
    f.advance(300000);
    f.guard.activity();
    expect(f.guard.snapshot().seconds).toBe(600);
    f.advance(540000);
    f.guard.activity();
    expect(f.guard.snapshot()).toMatchObject({ phase: 'warning', seconds: 60 });
    expect(() => f.guard.assertActive()).toThrow('Stay active');
    f.guard.stayActive();
    expect(f.guard.snapshot()).toMatchObject({ phase: 'active', seconds: 600 });
    expect(() => f.guard.stayActive()).toThrow('no active');
  });
  it('rejects stale approvals even after returning to the connection screen', () => {
    const f = fixture();
    const lease = f.guard.lease();
    f.guard.end('manual');
    expect(() => lease()).toThrow('invalidated');
    expect(() => f.guard.lease()).toThrow('session ended');
    expect(() => f.guard.stayActive()).toThrow('no active');
    f.guard.activity();
    f.guard.returnToConnection();
    expect(() => lease()).toThrow('invalidated');
    expect(f.guard.snapshot()).toMatchObject({ phase: 'active', seconds: 600 });
    expect(() => f.guard.returnToConnection()).toThrow('not active');
  });
  it('rechecks elapsed time on every action instead of relying on the scheduled timer', () => {
    let now = 0;
    let ended = false;
    const guard = new IdleProtection(
      { minutes: 5, notifications: false },
      () => ({ wall: now, monotonic: now }),
      () => {},
      () => {
        ended = true;
      },
    );
    now = 300000;
    expect(() => guard.lease()).toThrow('session ended');
    expect(ended).toBe(true);
  });
  it('counts suspend gaps and clock jumps without extending the policy on clock rollback', () => {
    const forward = fixture();
    forward.wall(600000);
    expect(forward.guard.snapshot().phase).toBe('shielded');
    const rollback = fixture();
    rollback.wall(-5000);
    expect(rollback.guard.snapshot()).toMatchObject({ phase: 'shielded', reason: 'clock-change' });
    const mono = fixture();
    mono.mono(600000);
    expect(mono.guard.snapshot().phase).toBe('shielded');
  });
  it('does not arm automatic expiry or OS lock handling when disabled, but permits manual ending', () => {
    const f = fixture(0);
    f.advance(10000000);
    f.guard.systemEvent('sleep');
    f.guard.systemEvent('os-lock');
    expect(f.guard.snapshot().phase).toBe('active');
    f.guard.configure({ minutes: 5, notifications: true });
    expect(f.guard.snapshot().seconds).toBe(300);
    f.guard.systemEvent('os-lock');
    expect(f.guard.snapshot()).toMatchObject({ phase: 'shielded', reason: 'os-lock' });
    expect(() => f.guard.configure({ minutes: 0, notifications: false })).toThrow('session ended');
    const sleep = fixture();
    sleep.guard.systemEvent('sleep');
    expect(sleep.guard.snapshot().reason).toBe('sleep');
  });
  it('does not expose mutable settings and validates settings rather than accepting arbitrary deadlines', () => {
    const f = fixture();
    const state = f.guard.snapshot();
    state.settings.minutes = 0;
    expect(f.guard.snapshot().settings.minutes).toBe(10);
    for (const value of [-1, 1, 9, 120, '10', NaN])
      expect(idleSettingsSchema.safeParse({ minutes: value, notifications: false }).success).toBe(
        false,
      );
    expect(
      idleSettingsSchema.safeParse({ minutes: 10, notifications: false, action: 'run' }).success,
    ).toBe(false);
  });
});
