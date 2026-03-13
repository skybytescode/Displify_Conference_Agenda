import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, combineLatest, map, shareReplay } from 'rxjs';
import {
  AgendaData,
  EnrichedSession,
  Room,
  SessionStatus,
  TimeSlot
} from '../models/agenda.model';
import { ClockService } from './clock.service';

@Injectable({ providedIn: 'root' })
export class AgendaService {
  private http  = inject(HttpClient);
  private clock = inject(ClockService);

  readonly agendaData$: Observable<AgendaData> = this.http
    .get<AgendaData>('assets/agenda.json')
    .pipe(shareReplay(1));

  /** Emits current time — delegates to ClockService (real or simulated). */
  readonly now$: Observable<Date> = this.clock.now$;

  readonly enrichedSessions$: Observable<EnrichedSession[]> = combineLatest([
    this.agendaData$,
    this.now$
  ]).pipe(
    map(([data, now]) => this.enrichSessions(data, now)),
    shareReplay(1)
  );

  readonly currentSession$: Observable<EnrichedSession | null> =
    this.enrichedSessions$.pipe(
      map(sessions => {
        const ongoing = sessions.filter(s => s.status === 'ongoing');
        return (
          ongoing.find(s => s.roomId === 'sala-conferinta') ?? ongoing[0] ?? null
        );
      })
    );

  readonly nextSession$: Observable<EnrichedSession | null> =
    this.enrichedSessions$.pipe(
      map(sessions => {
        const next = sessions.filter(s => s.status === 'next');
        return (
          next.find(s => s.roomId === 'sala-conferinta') ?? next[0] ?? null
        );
      })
    );

  readonly timeSlots$: Observable<TimeSlot[]> = this.enrichedSessions$.pipe(
    map(sessions => {
      const slotMap = new Map<string, EnrichedSession[]>();
      for (const s of sessions) {
        const existing = slotMap.get(s.startTime) ?? [];
        slotMap.set(s.startTime, [...existing, s]);
      }
      return [...slotMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([startTime, sessions]) => ({ startTime, sessions }));
    }),
    shareReplay(1)
  );

  private enrichSessions(data: AgendaData, now: Date): EnrichedSession[] {
    const roomMap = new Map<string, Room>(data.rooms.map(r => [r.id, r]));

    // Minute precision for status comparisons (session boundaries are on the minute)
    const nowMin = now.getHours() * 60 + now.getMinutes();
    // Second precision for smooth progress bar
    const nowSec = nowMin * 60 + now.getSeconds();

    // Determine the earliest upcoming start time (for "next" batch logic)
    const nextStartTime = data.sessions
      .map(s => s.startTime)
      .filter(t => this.toMin(t) > nowMin)
      .sort()[0] ?? null;

    return data.sessions.map(s => {
      const startMin = this.toMin(s.startTime);
      const endMin   = this.toMin(s.endTime);
      const startSec = startMin * 60;
      const endSec   = endMin   * 60;
      const room     = roomMap.get(s.roomId);

      let status: SessionStatus;
      let progress = 0;
      let minutesUntilStart = 0;

      if (nowMin >= endMin) {
        status = 'done';
      } else if (nowMin >= startMin) {
        status   = 'ongoing';
        progress = Math.min(100, ((nowSec - startSec) / (endSec - startSec)) * 100);
      } else if (s.startTime === nextStartTime) {
        status            = 'next';
        minutesUntilStart = startMin - nowMin;
      } else {
        status            = 'upcoming';
        minutesUntilStart = startMin - nowMin;
      }

      return { ...s, status, progress, minutesUntilStart, room };
    });
  }

  private toMin(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  }
}
