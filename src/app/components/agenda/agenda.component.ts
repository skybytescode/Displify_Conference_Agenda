import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs/operators';

import QRCode from 'qrcode';

import { AgendaService } from '../../services/agenda.service';
import { ClockService } from '../../services/clock.service';
import { EnrichedSession, SessionStatus, TimeSlot } from '../../models/agenda.model';

// ── Bokeh particle system ────────────────────────────────────────────────────
// Performance: particles are pre-rendered to offscreen sprite canvases at init.
// Each frame only calls drawImage() with globalAlpha — zero gradient creation,
// zero string parsing, zero arc() calls per particle.  Buttery-smooth 60 fps.

interface BokehTier {
  rMin:     number;
  rMax:     number;
  softness: number;
  aMin:     number;
  aMax:     number;
  vMin:     number;
  vMax:     number;
  weight:   number;
}

const TIERS: BokehTier[] = [
  { rMin: 1,   rMax: 4,   softness: 1.2, aMin: 0.40, aMax: 0.80, vMin: 60,  vMax: 160, weight: 0.38 },
  { rMin: 8,   rMax: 30,  softness: 2.2, aMin: 0.12, aMax: 0.38, vMin: 28,  vMax: 80,  weight: 0.30 },
  { rMin: 32,  rMax: 85,  softness: 3.0, aMin: 0.06, aMax: 0.20, vMin: 12,  vMax: 38,  weight: 0.22 },
  { rMin: 90,  rMax: 190, softness: 4.0, aMin: 0.03, aMax: 0.10, vMin: 5,   vMax: 18,  weight: 0.10 },
];

const COLORS: [number, number, number][] = [
  [255, 155, 40 ],  // warm amber
  [255, 115, 25 ],  // deep orange
  [255, 195, 80 ],  // yellow-orange
  [220,  88, 35 ],  // burnt orange
  [175, 210, 255],  // cool blue-white
  [0,   210, 228],  // cyan accent
  [165, 140, 255],  // soft purple
];

// Sprite size per tier — drawn once, reused every frame
const SPRITE_SIZE = [16, 64, 128, 256];

interface Particle {
  x:           number;
  y:           number;
  r:           number;
  softness:    number;
  vy:          number;
  vx:          number;
  alpha:       number;
  colorIdx:    number;
  tierIdx:     number;
  swayAmp:     number;
  swayFreq:    number;
  swayPhase:   number;
  t:           number;
  age:         number;
  fadeInDur:   number;
  breatheAmp:  number;
  breatheFreq: number;
  breathePhase:number;
  scaleAmp:    number;
  scaleFreq:   number;
  scalePhase:  number;
  speedAmp:    number;
  speedPhase:  number;
}

const N_PARTICLES = 80;

@Component({
  selector: 'app-agenda',
  standalone: true,
  imports: [],
  templateUrl: './agenda.component.html',
  styleUrl: './agenda.component.scss'
})
export class AgendaComponent implements AfterViewInit, OnDestroy {

  @ViewChild('bgCanvas') private canvasRef!: ElementRef<HTMLCanvasElement>;

  private agendaService = inject(AgendaService);
  private clock         = inject(ClockService);
  private route         = inject(ActivatedRoute);

  protected isSimulating = this.clock.isSimulating;

  // ── Live clock — uses ClockService (real or simulated) ────────────────────
  protected now = toSignal(this.clock.now$, { initialValue: new Date() });

  // ── Display mode ───────────────────────────────────────────────────────────
  protected mode = toSignal(
    this.route.queryParams.pipe(
      map(p => (p['mode'] === 'compact' ? 'compact' : 'full') as 'full' | 'compact')
    ),
    { initialValue: 'full' as 'full' | 'compact' }
  );

  // ── Future-slots limit — ?nextSlots=N (omit for unlimited) ────────────────
  protected nextSlotsLimit = toSignal(
    this.route.queryParams.pipe(
      map(p => p['nextSlots'] ? Math.max(1, parseInt(p['nextSlots'], 10)) : null)
    ),
    { initialValue: null as number | null }
  );

  // ── Agenda data ────────────────────────────────────────────────────────────
  protected agendaData     = toSignal(this.agendaService.agendaData$);
  protected currentSession = toSignal(this.agendaService.currentSession$);
  protected nextSession    = toSignal(this.agendaService.nextSession$);
  protected timeSlots      = toSignal(this.agendaService.timeSlots$, { initialValue: [] as TimeSlot[] });

  // ── QR code ────────────────────────────────────────────────────────────────
  protected qrImageUrl = signal<string | null>(null);

  // ── Progress bar — suppress backward transition on session change ──────────
  protected progressAnimate = signal(true);
  private   trackedSessionId: string | null = null;

  constructor() {
    effect(() => {
      const data = this.agendaData();
      if (!data) return;
      const url = data.conference.website ?? 'https://displify.com';
      QRCode.toDataURL(url, {
        width:  200,
        margin: 1,
        color:  { dark: '#ffffff', light: '#00000000' },
      }).then(dataUrl => this.qrImageUrl.set(dataUrl));
    });

    effect(() => {
      const id = this.currentSession()?.id ?? null;
      if (id !== this.trackedSessionId) {
        this.trackedSessionId = id;
        // Kill transition for 2 frames so the bar jumps instantly to 0
        this.progressAnimate.set(false);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => this.progressAnimate.set(true))
        );
      }
    });
  }

  protected visibleSlots = computed(() => {
    // Only show slots that are not fully done (no past events)
    const upcoming = this.timeSlots().filter(slot =>
      slot.sessions.some(s => s.status !== 'done')
    );
    const limit = this.nextSlotsLimit();
    return limit !== null ? upcoming.slice(0, limit) : upcoming;
  });

  // ── Bokeh canvas ───────────────────────────────────────────────────────────
  private ctx!:        CanvasRenderingContext2D;
  private particles:   Particle[] = [];
  private animFrameId  = 0;
  private lastTime     = 0;
  private sceneTime    = 0;
  private resizeObs!:  ResizeObserver;
  private canvasScale  = 1;

  // Pre-rendered sprite lookup: sprites[tierIdx][colorIdx] = OffscreenCanvas
  private sprites: OffscreenCanvas[][] = [];
  // Pre-rendered background gradient (reused every frame, rebuilt on resize)
  private bgGrad!: CanvasGradient;
  // Robot+cat image drawn on canvas with screen blending
  private robotImg: HTMLImageElement | null = null;
  // Pre-rendered feather mask for the robot image (rebuilt on resize)
  private robotMask: OffscreenCanvas | null = null;
  private robotMaskW = 0;
  private robotMaskH = 0;

  ngAfterViewInit(): void {
    const canvas  = this.canvasRef.nativeElement;
    this.ctx      = canvas.getContext('2d')!;
    this.buildSprites();
    this.loadRobotImage();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement!);
    this.resize();
    this.animFrameId = requestAnimationFrame(ts => this.loop(ts));
  }

  private loadRobotImage(): void {
    const img = new Image();
    img.src = 'assets/robotandcat.png';
    img.onload = () => { this.robotImg = img; this.buildRobotMask(); };
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animFrameId);
    this.resizeObs?.disconnect();
  }

  /** Build offscreen sprite canvases — one per tier × color. Called once. */
  private buildSprites(): void {
    this.sprites = TIERS.map((tier, ti) => {
      const size = SPRITE_SIZE[ti];
      const half = size / 2;
      return COLORS.map(([cr, cg, cb]) => {
        const oc  = new OffscreenCanvas(size, size);
        const oct = oc.getContext('2d')!;
        const grad = oct.createRadialGradient(half, half, 0, half, half, half);
        grad.addColorStop(0.00, `rgba(${cr},${cg},${cb},1)`);
        grad.addColorStop(0.15, `rgba(${cr},${cg},${cb},0.60)`);
        grad.addColorStop(0.45, `rgba(${cr},${cg},${cb},0.20)`);
        grad.addColorStop(0.75, `rgba(${cr},${cg},${cb},0.04)`);
        grad.addColorStop(1.00, `rgba(${cr},${cg},${cb},0)`);
        oct.fillStyle = grad;
        oct.fillRect(0, 0, size, size);
        return oc;
      });
    });
  }

  /**
   * Pre-render the robot+cat image with feathered edges onto an OffscreenCanvas.
   * Rebuilt on resize so it stays sharp at any resolution.
   */
  private buildRobotMask(): void {
    if (!this.robotImg) return;
    const canvas = this.canvasRef.nativeElement;
    const ch = canvas.height;
    // Target 65% of canvas height, maintain aspect ratio
    const drawH = Math.round(ch * 0.65);
    const aspect = this.robotImg.naturalWidth / this.robotImg.naturalHeight;
    const drawW = Math.round(drawH * aspect);
    if (drawW < 1 || drawH < 1) return;

    const oc  = new OffscreenCanvas(drawW, drawH);
    const oct = oc.getContext('2d')!;

    // Draw the image
    oct.drawImage(this.robotImg, 0, 0, drawW, drawH);

    // Apply feathered edge mask using destination-in composite
    // This multiplies existing pixels by the mask alpha
    oct.globalCompositeOperation = 'destination-in';
    const feather = 0.15; // 15% feather on each edge
    const gx = oct.createLinearGradient(0, 0, drawW, 0);
    gx.addColorStop(0,            'rgba(0,0,0,0)');
    gx.addColorStop(feather,      'rgba(0,0,0,1)');
    gx.addColorStop(1 - feather,  'rgba(0,0,0,1)');
    gx.addColorStop(1,            'rgba(0,0,0,0)');
    oct.fillStyle = gx;
    oct.fillRect(0, 0, drawW, drawH);

    const gy = oct.createLinearGradient(0, 0, 0, drawH);
    gy.addColorStop(0,            'rgba(0,0,0,0)');
    gy.addColorStop(feather,      'rgba(0,0,0,1)');
    gy.addColorStop(1 - feather,  'rgba(0,0,0,1)');
    gy.addColorStop(1,            'rgba(0,0,0,0)');
    oct.fillStyle = gy;
    oct.fillRect(0, 0, drawW, drawH);

    oct.globalCompositeOperation = 'source-over';

    this.robotMask  = oc;
    this.robotMaskW = drawW;
    this.robotMaskH = drawH;
  }

  private resize(): void {
    const canvas = this.canvasRef.nativeElement;
    const p      = canvas.parentElement!;
    canvas.width  = p.offsetWidth;
    canvas.height = p.offsetHeight;
    this.canvasScale = Math.min(canvas.width / 1920, canvas.height / 1080);

    // Rebuild background gradient (depends on canvas dimensions)
    const { width: w, height: h } = canvas;
    this.bgGrad = this.ctx.createLinearGradient(0, 0, w * 0.6, h);
    this.bgGrad.addColorStop(0,    '#0e3f52');
    this.bgGrad.addColorStop(0.40, '#091e31');
    this.bgGrad.addColorStop(1,    '#040810');

    // Rebuild feathered robot sprite at new resolution
    this.buildRobotMask();

    this.initParticles();
  }

  // ── Particle spawning ──────────────────────────────────────────────────────

  private pickTier(): number {
    let acc = 0;
    const r = Math.random();
    for (let i = 0; i < TIERS.length; i++) {
      acc += TIERS[i].weight;
      if (r < acc) return i;
    }
    return TIERS.length - 1;
  }

  private spawnParticle(w: number, h: number, randomY: boolean): Particle {
    const tierIdx = this.pickTier();
    const tier    = TIERS[tierIdx];
    const s       = this.canvasScale;
    const r       = (tier.rMin + Math.random() * (tier.rMax - tier.rMin)) * s;
    const vy      = (tier.vMin + Math.random() * (tier.vMax - tier.vMin)) * s;

    const rnd = Math.random();
    const ci  = rnd < 0.42 ? Math.floor(Math.random() * 4)
              : rnd < 0.62 ? 4
              : rnd < 0.80 ? 5
              :               6;

    const scaleAmps  = [0.45, 0.22, 0.14, 0.09];
    const scaleFreqs = [[2.0, 5.5], [0.5, 1.4], [0.25, 0.75], [0.12, 0.40]];
    const breathAmps = [0.45, 0.25, 0.16, 0.10];
    const breathFreqs= [[1.2, 3.5], [0.35, 0.90], [0.20, 0.55], [0.12, 0.35]];
    const speedAmps  = [0.40, 0.28, 0.20, 0.14];

    const [sfMin, sfMax] = scaleFreqs[tierIdx] as [number, number];
    const [bfMin, bfMax] = breathFreqs[tierIdx] as [number, number];
    const drawMargin = r * tier.softness;

    return {
      x:            drawMargin + Math.random() * Math.max(w - drawMargin * 2, 1),
      y:            randomY ? Math.random() * (h + drawMargin) : h + drawMargin + Math.random() * 40,
      r,
      softness:     tier.softness,
      vy,
      vx:           (Math.random() - 0.5) * 4 * s,
      alpha:        tier.aMin + Math.random() * (tier.aMax - tier.aMin),
      colorIdx:     ci,
      tierIdx,
      swayAmp:      (4 + Math.random() * 22) * s,
      swayFreq:     0.06 + Math.random() * 0.20,
      swayPhase:    Math.random() * Math.PI * 2,
      t:            Math.random() * 100,
      age:          randomY ? 999 : 0,
      fadeInDur:    0.8 + Math.random() * 1.4,
      breatheAmp:   breathAmps[tierIdx] * (0.7 + Math.random() * 0.6),
      breatheFreq:  bfMin + Math.random() * (bfMax - bfMin),
      breathePhase: Math.random() * Math.PI * 2,
      scaleAmp:     scaleAmps[tierIdx] * (0.7 + Math.random() * 0.6),
      scaleFreq:    sfMin + Math.random() * (sfMax - sfMin),
      scalePhase:   Math.random() * Math.PI * 2,
      speedAmp:     speedAmps[tierIdx] * (0.6 + Math.random() * 0.8),
      speedPhase:   Math.random() * Math.PI * 2,
    };
  }

  private initParticles(): void {
    const { width: w, height: h } = this.canvasRef.nativeElement;
    // Scale count with area, cap at 2× to keep RAM low
    const areaRatio = (w * h) / (1920 * 1080);
    const count = Math.round(N_PARTICLES * Math.min(areaRatio, 2));
    this.particles = Array.from({ length: count }, () =>
      this.spawnParticle(w, h, true)
    );
  }

  // ── Animation loop ─────────────────────────────────────────────────────────

  private loop(ts: number): void {
    this.animFrameId = requestAnimationFrame(t => this.loop(t));
    const dt = Math.min((ts - this.lastTime) / 1000, 0.05);
    this.lastTime  = ts;
    this.sceneTime += dt;
    if (dt <= 0) return;
    this.update(dt);
    this.draw();
  }

  private update(dt: number): void {
    const { width: w, height: h } = this.canvasRef.nativeElement;
    for (const p of this.particles) {
      p.t   += dt;
      p.age += dt;

      const currentVy = p.vy * (1 + Math.sin(p.t * 0.45 + p.speedPhase) * p.speedAmp);
      p.y -= currentVy * dt;
      p.x += p.vx * dt + Math.sin(p.t * p.swayFreq + p.swayPhase) * p.swayAmp * dt;

      if (p.y + p.r * 1.5 < 0) {
        Object.assign(p, this.spawnParticle(w, h, false));
      }
      if (p.x < -p.r)    p.x = w + p.r;
      if (p.x > w + p.r) p.x = -p.r;
    }
  }

  private draw(): void {
    const canvas = this.canvasRef.nativeElement;
    const { width: w, height: h } = canvas;
    const ctx = this.ctx;

    // ── Background — reuse pre-built gradient ────────────────────────────────
    ctx.fillStyle = this.bgGrad;
    ctx.fillRect(0, 0, w, h);

    // ── Ambient glow — two soft radial fills ─────────────────────────────────
    const g1a = 0.07 + Math.sin(this.sceneTime * 0.18) * 0.04;
    const g2a = 0.05 + Math.cos(this.sceneTime * 0.13) * 0.03;
    const ra1 = ctx.createRadialGradient(w * 0.20, h * 0.25, 0, w * 0.20, h * 0.25, w * 0.60);
    ra1.addColorStop(0, `rgba(0,180,210,${+g1a.toFixed(3)})`);
    ra1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = ra1;
    ctx.fillRect(0, 0, w, h);
    const ra2 = ctx.createRadialGradient(w * 0.80, h * 0.75, 0, w * 0.80, h * 0.75, w * 0.55);
    ra2.addColorStop(0, `rgba(140,100,255,${+g2a.toFixed(3)})`);
    ra2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = ra2;
    ctx.fillRect(0, 0, w, h);

    // ── Robot+cat image — screen-blended into the background ───────────────
    if (this.robotMask) {
      const rx = ((w - this.robotMaskW) / 2) | 0;
      const ry = ((h - this.robotMaskH) / 2) | 0;
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.55;
      ctx.drawImage(this.robotMask, rx, ry);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // ── Particles — drawImage from pre-rendered sprites, zero gradient work ──
    for (const p of this.particles) {
      const fadeIn  = Math.min(p.age / p.fadeInDur, 1);
      const breathe = 1 + Math.sin(p.t * p.breatheFreq + p.breathePhase) * p.breatheAmp;
      const a       = p.alpha * fadeIn * breathe;
      if (a < 0.003) continue;

      const scale  = 1 + Math.sin(p.t * p.scaleFreq + p.scalePhase) * p.scaleAmp;
      const drawR  = p.r * scale * p.softness;
      const size   = drawR * 2;

      ctx.globalAlpha = a;
      ctx.drawImage(
        this.sprites[p.tierIdx][p.colorIdx],
        (p.x - drawR) | 0,
        (p.y - drawR) | 0,
        size, size
      );
    }
    ctx.globalAlpha = 1;
  }

  // ── Template helpers ────────────────────────────────────────────────────────

  protected formatClock(date: Date): string {
    return date.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  }

  protected formatDisplayDate(date: Date): string {
    return date
      .toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
      .toUpperCase();
  }

  protected formatConferenceDate(dateStr: string): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d)
      .toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
      .toUpperCase();
  }

  protected creditsDuration(speakers: { name: string }[]): string {
    return `${Math.max(4, speakers.length * 3)}s`;
  }

  protected slotStatus(sessions: EnrichedSession[]): SessionStatus {
    if (sessions.some(s => s.status === 'ongoing')) return 'ongoing';
    if (sessions.some(s => s.status === 'next'))    return 'next';
    if (sessions.every(s => s.status === 'done'))   return 'done';
    return 'upcoming';
  }

  protected typeLabel(type: string): string {
    const labels: Record<string, string> = {
      keynote:'KEYNOTE', panel:'PANEL', talk:'TALK',
      opening:'DESCHIDERE', registration:'ÎNREGISTRARE',
      break:'PAUZĂ', track:'TRACK', pitching:'PITCHING',
      matchmaking:'MATCHMAKING', networking:'NETWORKING',
      'invite-only':'INVITE ONLY'
    };
    return labels[type] ?? type.toUpperCase();
  }
}
