// Picks a quality tier: guess from the device at startup, then measure on the title screen and keep watching while playing.
// RC cost does not depend on how many lights are on screen, so a quiet title-screen measurement holds in combat too.

export const TIERS = [
  { name: "最低", rc: 0.2, dpr: 0.5, fix: false },
  { name: "低", rc: 0.25, dpr: 0.75, fix: false },
  { name: "中", rc: 0.35, dpr: 1, fix: true },
  { name: "高", rc: 0.5, dpr: 1.5, fix: true },
  { name: "最高", rc: 0.75, dpr: 2, fix: true },
];

export const PERF = {
  GPU_BUDGET_MS: 8, // per frame, leaves room for sprites/HUD/CPU at 60fps
  GPU_UP_RATIO: 0.4, // try one tier up if the measured GPU time is below budget*this
  NO_TIMER_SLOW_MS: 19, // without a GPU timer: median frame interval above this = too slow
  WARMUP_FRAMES: 12,
  SAMPLE_FRAMES: 30,
  RUN_WINDOW: 150, // frames
  RUN_SLOW_MS: 24, // while playing: median interval above this (~42fps) -> one tier down
  RUN_COOLDOWN_S: 6,
};

export function isMobile(renderer: string) {
  const nav = typeof navigator !== "undefined" ? navigator : ({} as Navigator);
  return /adreno|mali|powervr|apple gpu/i.test(renderer) || /android|iphone|ipad|mobile/i.test(nav.userAgent || "") || (typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches);
}

export function guessTier(renderer: string): number {
  const r = renderer.toLowerCase();
  const nav = typeof navigator !== "undefined" ? navigator : ({} as Navigator);
  const mobile = /adreno|mali|powervr|apple gpu/.test(r) || /android|iphone|ipad|mobile/i.test(nav.userAgent || "") || (typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches);
  const mem = (nav as Navigator & { deviceMemory?: number }).deviceMemory;
  let t: number;
  if (/swiftshader|llvmpipe|software|basic render/.test(r)) t = 0;
  else if (mobile) {
    const adreno = r.match(/adreno[^0-9]*(\d{3})/);
    const mali = r.match(/mali-g(\d+)/);
    if (adreno) t = +adreno[1] >= 730 ? 3 : +adreno[1] >= 640 ? 2 : 1;
    else if (mali) t = +mali[1] >= 710 ? 2 : 1;
    else if (/apple/.test(r)) t = 3;
    else t = 1;
  } else {
    if (/nvidia|geforce|rtx|radeon|amd/.test(r)) t = 4;
    else if (/apple m\d|apple gpu/.test(r)) t = 4;
    else if (/iris xe|arc/.test(r)) t = 3;
    else if (/intel/.test(r)) t = 2;
    else t = 3;
  }
  if (mem !== undefined && mem <= 2) t = Math.min(t, 1);
  return t;
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

export class AutoPerf {
  tier: number;
  phase: "calib" | "run" = "calib";
  log: string[] = [];
  private frames = 0;
  private samples: number[] = [];
  private triedUp = false;
  private wentDown = false;
  private runDt: number[] = [];
  private cooldown = 0;
  private lastGpuSerial = -1;

  private hasTimer: boolean;

  constructor(start: number, hasTimer: boolean) {
    this.hasTimer = hasTimer;
    this.tier = Math.max(0, Math.min(TIERS.length - 1, start));
  }

  // returns the new tier when it changes
  tick(dtMs: number, gpuMs: number, gpuSerial: number, playing: boolean): number | null {
    if (this.phase === "calib") {
      this.frames++;
      if (this.frames <= PERF.WARMUP_FRAMES) return null;
      if (this.hasTimer) {
        if (gpuMs < 0 || gpuSerial === this.lastGpuSerial) return null;
        this.lastGpuSerial = gpuSerial;
        this.samples.push(gpuMs);
      } else this.samples.push(dtMs);
      if (this.samples.length < PERF.SAMPLE_FRAMES) return null;
      const m = median(this.samples);
      this.log.push(`${TIERS[this.tier].name}: ${m.toFixed(2)}ms(${this.hasTimer ? "GPU" : "間隔"})`);
      const slow = this.hasTimer ? m > PERF.GPU_BUDGET_MS : m > PERF.NO_TIMER_SLOW_MS;
      if (slow && this.tier > 0) {
        this.wentDown = true;
        return this.set(this.tier - 1);
      }
      if (this.hasTimer && !slow && !this.wentDown && !this.triedUp && m < PERF.GPU_BUDGET_MS * PERF.GPU_UP_RATIO && this.tier < TIERS.length - 1) {
        this.triedUp = true;
        return this.set(this.tier + 1);
      }
      this.phase = "run";
      return null;
    }
    if (!playing) {
      this.runDt = [];
      return null;
    }
    this.cooldown -= dtMs / 1000;
    this.runDt.push(dtMs);
    if (this.runDt.length > PERF.RUN_WINDOW) this.runDt.shift();
    if (this.runDt.length === PERF.RUN_WINDOW && this.cooldown <= 0 && this.tier > 0) {
      const slowDt = median(this.runDt) > PERF.RUN_SLOW_MS;
      const slowGpu = this.hasTimer && gpuMs > PERF.GPU_BUDGET_MS * 1.8;
      if (slowDt || slowGpu) {
        this.cooldown = PERF.RUN_COOLDOWN_S;
        this.runDt = [];
        this.log.push(`プレイ中に重い → ${TIERS[this.tier - 1].name}`);
        this.tier--;
        return this.tier;
      }
    }
    return null;
  }

  private set(t: number) {
    this.tier = t;
    this.frames = 0;
    this.samples = [];
    return t;
  }
}
