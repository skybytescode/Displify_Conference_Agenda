import { Injectable } from '@angular/core';
import { Observable, interval, map, shareReplay, startWith } from 'rxjs';

/**
 * Provides the current time as an observable.
 *
 * Normal mode  — emits real Date every second.
 * Simulation   — driven by URL query params:
 *   ?simStart=08:55&simEnd=21:00&simDuration=210
 *   Compresses the time span into `simDuration` real seconds.
 */
@Injectable({ providedIn: 'root' })
export class ClockService {

  readonly now$: Observable<Date>;

  /** True when running in simulation mode (shown in UI as an indicator). */
  readonly isSimulating: boolean;

  constructor() {
    const sim = this.readSimParams();
    this.isSimulating = sim !== null;

    if (sim) {
      const { startMs, speedFactor } = sim;
      const wallStart = Date.now();

      // Tick every 16 ms real-time (~60 fps) for smooth bar/percentage sync
      this.now$ = interval(16).pipe(
        startWith(0),
        map(() => new Date(startMs + (Date.now() - wallStart) * speedFactor)),
        shareReplay(1)
      );
    } else {
      this.now$ = interval(1000).pipe(
        startWith(0),
        map(() => new Date()),
        shareReplay(1)
      );
    }
  }

  // ── Simulation param parsing ────────────────────────────────────────────────

  private readSimParams(): { startMs: number; speedFactor: number } | null {
    const p           = new URLSearchParams(window.location.search);
    const simStart    = p.get('simStart');
    const simEnd      = p.get('simEnd');
    const simDuration = p.get('simDuration');

    if (!simStart || !simEnd || !simDuration) return null;

    const startMin   = this.toMin(simStart);
    const endMin     = this.toMin(simEnd);
    const durationSec = Number(simDuration);

    if (isNaN(startMin) || isNaN(endMin) || isNaN(durationSec) || durationSec <= 0 || endMin <= startMin) {
      return null;
    }

    const today   = new Date();
    const startMs = new Date(
      today.getFullYear(), today.getMonth(), today.getDate(),
      Math.floor(startMin / 60), startMin % 60, 0, 0
    ).getTime();

    const spanSec    = (endMin - startMin) * 60;   // real seconds in the span
    const speedFactor = spanSec / durationSec;     // e.g. 43500 / 210 ≈ 207×

    return { startMs, speedFactor };
  }

  private toMin(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }
}
