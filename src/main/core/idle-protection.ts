import { idleSettingsSchema, type IdleSettings, type IdleState } from '../../shared/idle';

// Main owns elapsed time. Wall time catches suspend on platforms whose monotonic clock pauses.
export class IdleProtection {
  private settings: IdleSettings;
  private phase: IdleState['phase'] = 'active';
  private reason: IdleState['reason'] = 'idle';
  private elapsed = 0;
  private wall: number;
  private monotonic: number;
  private epoch = 0;
  private last = '';
  constructor(
    settings: IdleSettings,
    private readonly clock: () => { wall: number; monotonic: number },
    private readonly changed: (state: IdleState) => void,
    private readonly ended: () => void,
  ) {
    this.settings = idleSettingsSchema.parse(settings);
    const now = clock();
    this.wall = now.wall;
    this.monotonic = now.monotonic;
  }
  snapshot(): IdleState {
    this.tick();
    return this.state();
  }
  private state(): IdleState {
    return {
      phase: this.phase,
      seconds:
        this.phase === 'shielded' || !this.settings.minutes
          ? 0
          : Math.max(0, Math.ceil((this.settings.minutes * 60000 - this.elapsed) / 1000)),
      settings: { ...this.settings },
      reason: this.reason,
    };
  }
  private emit(): void {
    const state = this.state();
    const next = JSON.stringify(state);
    if (next !== this.last) {
      this.last = next;
      this.changed(state);
    }
  }
  tick(): void {
    const now = this.clock();
    const wallDelta = now.wall - this.wall;
    const monoDelta = now.monotonic - this.monotonic;
    this.wall = now.wall;
    this.monotonic = now.monotonic;
    if (this.phase === 'shielded' || !this.settings.minutes) return;
    if (wallDelta < -1000 || monoDelta < 0 || !Number.isFinite(wallDelta + monoDelta)) {
      this.end('clock-change');
      return;
    }
    this.elapsed += Math.max(0, wallDelta, monoDelta);
    if (this.elapsed >= this.settings.minutes * 60000) this.end('idle');
    else {
      if (this.elapsed >= this.settings.minutes * 60000 - 60000) this.phase = 'warning';
      this.emit();
    }
  }
  activity(): void {
    this.tick();
    if (this.phase !== 'active') return;
    this.elapsed = 0;
    this.emit();
  }
  stayActive(): void {
    this.tick();
    if (this.phase !== 'warning') throw new Error('There is no active idle warning.');
    this.phase = 'active';
    this.elapsed = 0;
    this.emit();
  }
  assertActive(): void {
    this.tick();
    if (this.phase !== 'active')
      throw new Error(
        this.phase === 'warning'
          ? 'Choose Stay active before starting another operation.'
          : 'The session ended for privacy. Return to a fresh connection screen.',
      );
  }
  lease(): () => void {
    this.assertActive();
    const epoch = this.epoch;
    return () => {
      this.tick();
      if (epoch !== this.epoch || this.phase === 'shielded')
        throw new Error(
          'Session protection invalidated this request. Start again from the new connection screen.',
        );
    };
  }
  configure(settings: IdleSettings): void {
    this.assertActive();
    this.settings = idleSettingsSchema.parse(settings);
    this.elapsed = 0;
    this.emit();
  }
  end(reason: IdleState['reason']): void {
    if (this.phase === 'shielded') return;
    this.phase = 'shielded';
    this.reason = reason;
    this.epoch++;
    try {
      this.emit();
    } finally {
      this.ended();
    }
  }
  systemEvent(reason: 'os-lock' | 'sleep'): void {
    if (this.settings.minutes) this.end(reason);
  }
  returnToConnection(): void {
    if (this.phase !== 'shielded') throw new Error('Session protection is not active.');
    this.epoch++;
    this.phase = 'active';
    this.reason = 'idle';
    this.elapsed = 0;
    const now = this.clock();
    this.wall = now.wall;
    this.monotonic = now.monotonic;
    this.emit();
  }
}
