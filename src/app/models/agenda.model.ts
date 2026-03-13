export type SessionType =
  | 'registration'
  | 'opening'
  | 'keynote'
  | 'panel'
  | 'talk'
  | 'break'
  | 'track'
  | 'pitching'
  | 'matchmaking'
  | 'invite-only'
  | 'networking';

export type SessionStatus = 'done' | 'ongoing' | 'next' | 'upcoming';

export interface Speaker {
  name: string;
  affiliation: string;
}

export interface SubSession {
  id: string;
  startTime: string;
  endTime: string;
  type: string;
  title: string;
  speakers: Speaker[];
  jury?: Speaker[];
}

export interface Session {
  id: string;
  startTime: string;
  endTime: string;
  roomId: string;
  type: SessionType;
  title: string;
  description: string;
  speakers: Speaker[];
  subSessions?: SubSession[];
}

export interface Room {
  id: string;
  name: string;
  shortName: string;
}

export interface Conference {
  name: string;
  date: string;
  location: string;
  website?: string;
  expoHours: { open: string; close: string };
}

export interface AgendaData {
  conference: Conference;
  rooms: Room[];
  sessions: Session[];
}

export interface EnrichedSession extends Session {
  status: SessionStatus;
  /** 0–100, meaningful only when status === 'ongoing' */
  progress: number;
  /** Minutes until start, meaningful when status === 'next' | 'upcoming' */
  minutesUntilStart: number;
  room: Room | undefined;
}

export interface TimeSlot {
  startTime: string;
  sessions: EnrichedSession[];
}
