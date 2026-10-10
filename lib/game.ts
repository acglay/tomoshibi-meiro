import { T, KNOBS, KNOB_DEFAULT, KnobKey } from "./tuning";
import { Batch, Frame, PROBE_N } from "./rc";

type V3 = [number, number, number];
// directions: 0 right, 1 down, 2 left, 3 up, -1 stopped
export const DX = [1, 0, -1, 0];
export const DY = [0, 1, 0, -1];
const REV = [2, 3, 0, 1];

// tiles
export const OPEN = 0;
export const WALL = 1;
export const DOOR = 2; // ghosts only
export const PEN = 3; // ghosts only

type Mover = { tx: number; ty: number; dir: number; t: number }; // at tile (tx,ty), t of the way to the next tile along dir
export type GhostState = "pen" | "leave" | "out" | "eyes";
export type Ghost = Mover & {
  id: number; state: GhostState; wait: number; hp: number; burn: number; lum: number;
  c: V3; slot: number; flash: number; burnedBy: number; blow: number; blowAt: number;
};
type Spark = { x: number; y: number; vx: number; vy: number; life: number; max: number; c: V3 };
type Light = { x: number; y: number; r: number; e: number; life: number; max: number; c: V3; kind: "flash" | "ember" };

const PELLET_C: V3 = [1.0, 0.78, 0.42];
const POWER_C: V3 = [1.0, 0.62, 0.3];
const BURST_C: V3 = [1.0, 0.86, 0.6];
const PURPLE: V3 = [0.7, 0.3, 1.0];
const GHOST_C: V3[] = [[0.95, 0.35, 0.4], [0.95, 0.6, 0.85], [0.4, 0.85, 0.95], [0.98, 0.7, 0.35]];

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Input = { want: number; burst: boolean };

let MAP_SERIAL = 0;

export class Game {
  seed: number;
  rng: () => number;
  W = 0;
  H = 0;
  map = new Uint8Array(0);
  mapVersion = 0;
  pellet = new Uint8Array(0); // 0 none, 1 pellet, 2 power, 3 blown out by a ghost (dark, still to be eaten)
  pelletsLeft = 0;
  pelletsTotal = 0;
  tileLum = new Float32Array(0); // light at every tile center, read back from the GPU
  lumSerialSeen = 0;
  distExit: Int16Array = new Int16Array(0); // ghost BFS to the tile above the door
  distPen: Int16Array = new Int16Array(0); // ghost BFS to the pen center
  distRoad = new Int32Array(0); // BFS from the player over tiles the ghosts can walk (below GHOST_WALL), every update
  penX = 0;
  penY = 0;
  exitX = 0;
  exitY = 0;
  startX = 0;
  startY = 0;
  edges: number[][] = [];
  // player
  p: Mover = { tx: 0, ty: 0, dir: -1, t: 0 };
  face = 2;
  mouth = 0;
  charge = 0;
  bursts = 0;
  lives = T.LIVES;
  score = 0;
  stage = 1;
  ghosts: Ghost[] = [];
  lights: Light[] = [];
  sparks: Spark[] = [];
  burstSerial = 0;
  burstChain = 0;
  lastBurstT = -1e9;
  burned = 0;
  deaths = 0;
  blown = 0;
  time = 0;
  stageTime = 0;
  hitstop = 0;
  shake = 0;
  dying = 0;
  clearing = 0;
  over = false;
  paused = false;
  lightCount = 0;
  probeKeys: number[] = []; // tile index, or -1-ghostIndex
  probeSerial = 0;
  pendingProbe = new Map<number, number[]>();
  onToast: (text: string, color?: string) => void = () => {};
  onStage: (s: number) => void = () => {};
  input: Input = { want: -1, burst: false };
  knobs = Object.fromEntries(KNOBS.map((k, i) => [k.key, k.vals[KNOB_DEFAULT[i]]])) as Record<KnobKey, number>;

  scene = new Batch();
  lit = new Batch();
  glow = new Batch();
  probes = new Float32Array(PROBE_N * 2);

  constructor(seed: number) {
    this.seed = seed;
    this.rng = mulberry(seed);
    this.newStage(1);
  }

  idx(x: number, y: number) {
    return y * this.W + x;
  }
  tile(x: number, y: number) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return WALL;
    return this.map[y * this.W + x];
  }
  playerOk(x: number, y: number) {
    return this.tile(x, y) === OPEN;
  }
  ghostOk(g: Ghost, x: number, y: number) {
    const v = this.tile(x, y);
    if (v === WALL) return false;
    if (g.state === "out") return v === OPEN;
    return true;
  }
  // world position of a mover (tile units)
  pos(m: Mover): [number, number] {
    const d = m.dir < 0 ? 0 : m.t;
    const dir = Math.max(0, m.dir);
    return [m.tx + 0.5 + DX[dir] * d, m.ty + 0.5 + DY[dir] * d];
  }
  // the tile a mover is mostly on
  near(m: Mover): [number, number] {
    if (m.dir < 0 || m.t < 0.5) return [m.tx, m.ty];
    return [m.tx + DX[m.dir], m.ty + DY[m.dir]];
  }

  private inPen(x: number, y: number) {
    return x >= this.penX - 3 && x <= this.penX + 3 && y >= this.penY - 3 && y <= this.penY + 3;
  }

  private buildMaze() {
    const [CW, CH] = T.STAGE_CELLS[Math.min(this.stage, T.STAGE_CELLS.length) - 1];
    this.W = 2 * CW + 1;
    this.H = 2 * CH + 1;
    const n = this.W * this.H;
    this.map = new Uint8Array(n);
    this.pellet = new Uint8Array(n);
    this.tileLum = new Float32Array(n);
    this.distRoad = new Int32Array(n);
    const W = this.W;
    const H = this.H;
    const mid = (CW - 1) >> 1;
    const R = this.rng;
    const m = this.map;
    this.penX = W >> 1;
    this.penY = H >> 1;
    if (this.penY % 2 === 0) this.penY--;
    // tiles of the pen block (walls + interior): x penX-3..penX+3, y penY-3..penY+3; the ring around it is open
    const set = (x: number, y: number, v: number) => {
      m[y * W + x] = v;
      m[y * W + (W - 1 - x)] = v;
    };
    const wallSlotFree = (x: number, y: number) => !this.inPen(x, y) && x > 0 && y > 0 && x < W - 1 && y < H - 1;
    for (let attempt = 0; attempt < 50; attempt++) {
      m.fill(WALL);
      // perfect maze on the left half (center column included), mirrored
      const seen = new Uint8Array(CW * CH);
      const stack: [number, number][] = [[mid, CH - 1]];
      seen[(CH - 1) * CW + mid] = 1;
      set(2 * mid + 1, 2 * (CH - 1) + 1, OPEN);
      while (stack.length) {
        const [cx, cy] = stack[stack.length - 1];
        const nb: [number, number][] = [];
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d];
          const ny = cy + DY[d];
          if (nx < 0 || ny < 0 || nx > mid || ny >= CH || seen[ny * CW + nx]) continue;
          nb.push([nx, ny]);
        }
        if (!nb.length) { stack.pop(); continue; }
        const [nx, ny] = nb[Math.floor(R() * nb.length)];
        seen[ny * CW + nx] = 1;
        set(cx + nx + 1, cy + ny + 1, OPEN);
        set(2 * nx + 1, 2 * ny + 1, OPEN);
        stack.push([nx, ny]);
      }
      // loops
      for (let cy = 0; cy < CH; cy++)
        for (let cx = 0; cx <= mid; cx++)
          for (const d of [0, 1]) {
            const nx = cx + DX[d];
            const ny = cy + DY[d];
            if (nx > mid || ny >= CH) continue;
            const wx = cx + nx + 1;
            const wy = cy + ny + 1;
            if (m[wy * W + wx] === WALL && wallSlotFree(wx, wy) && R() < T.LOOP_CHANCE) set(wx, wy, OPEN);
          }
      // the pen: open ring, wall ring, interior, door at the top
      const px = this.penX;
      const py = this.penY;
      for (let y = py - 4; y <= py + 4; y++)
        for (let x = px - 4; x <= px + 4; x++) {
          const ring = Math.abs(x - px) === 4 || Math.abs(y - py) === 4;
          const wallRing = Math.abs(x - px) === 3 || Math.abs(y - py) === 3;
          m[y * W + x] = ring ? OPEN : wallRing ? WALL : PEN;
        }
      m[(py - 3) * W + px] = DOOR;
      // braid: no dead ends (a dead end in the dark is a sure death)
      for (let pass = 0; pass < 3; pass++)
        for (let y = 1; y < H - 1; y += 2)
          for (let x = 1; x < W - 1; x += 2) {
            if (m[y * W + x] !== OPEN || this.inPen(x, y)) continue;
            let n = 0;
            for (let d = 0; d < 4; d++) if (m[(y + DY[d]) * W + x + DX[d]] === OPEN) n++;
            if (n !== 1) continue;
            const opts: number[] = [];
            for (let d = 0; d < 4; d++) {
              const wx = x + DX[d];
              const wy = y + DY[d];
              const bx = x + 2 * DX[d];
              const by = y + 2 * DY[d];
              if (m[wy * W + wx] === WALL && wallSlotFree(wx, wy) && bx > 0 && by > 0 && bx < W - 1 && by < H - 1 && m[by * W + bx] === OPEN) opts.push(d);
            }
            if (!opts.length) continue;
            const d = opts[Math.floor(R() * opts.length)];
            set(x + DX[d], y + DY[d], OPEN);
          }
      this.startX = px;
      this.startY = py + 6;
      if (m[this.startY * W + this.startX] !== OPEN) continue;
      // every open tile reachable from the start, no dead ends
      const reach = this.bfs([[this.startX, this.startY]], (x, y) => this.tile(x, y) === OPEN);
      let ok = true;
      for (let i = 0; i < W * H; i++) {
        if (m[i] !== OPEN) continue;
        if (reach[i] < 0) { ok = false; break; }
        const x = i % W;
        const y = (i / W) | 0;
        let n = 0;
        for (let d = 0; d < 4; d++) if (this.tile(x + DX[d], y + DY[d]) === OPEN) n++;
        if (n < 2) { ok = false; break; }
      }
      if (ok) break;
    }
    this.exitX = this.penX;
    this.exitY = this.penY - 4;
    const ghostTile = (x: number, y: number) => this.tile(x, y) !== WALL;
    this.distExit = Int16Array.from(this.bfs([[this.exitX, this.exitY]], ghostTile));
    this.distPen = Int16Array.from(this.bfs([[this.penX, this.penY]], ghostTile));
    this.buildEdges();
  }

  bfs(src: [number, number][], ok: (x: number, y: number) => boolean, out?: Int32Array) {
    const W = this.W;
    const d = out ?? new Int32Array(W * this.H);
    d.fill(-1);
    const q = new Int32Array(W * this.H);
    let h = 0;
    let n = 0;
    for (const [x, y] of src) { d[y * W + x] = 0; q[n++] = y * W + x; }
    while (h < n) {
      const i = q[h++];
      const x = i % W;
      const y = (i / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= this.H) continue;
        const j = ny * W + nx;
        if (d[j] >= 0 || !ok(nx, ny)) continue;
        d[j] = d[i] + 1;
        q[n++] = j;
      }
    }
    return d;
  }

  // display-only outline of every wall face that touches a walkable tile (merged into runs)
  private buildEdges() {
    const E: number[][] = [];
    const W = this.W;
    const H = this.H;
    const solid = (x: number, y: number) => this.tile(x, y) === WALL;
    for (const dir of [-1, 1]) {
      for (let y = 0; y < H; y++) {
        let run = -1;
        for (let x = 0; x <= W; x++) {
          const on = x < W && solid(x, y) && y + dir >= 0 && y + dir < H && !solid(x, y + dir);
          if (on && run < 0) run = x;
          if (!on && run >= 0) {
            const yy = dir < 0 ? y : y + 1;
            E.push([run, yy, x, yy]);
            run = -1;
          }
        }
      }
      for (let x = 0; x < W; x++) {
        let run = -1;
        for (let y = 0; y <= H; y++) {
          const on = y < H && solid(x, y) && x + dir >= 0 && x + dir < W && !solid(x + dir, y);
          if (on && run < 0) run = y;
          if (!on && run >= 0) {
            const xx = dir < 0 ? x : x + 1;
            E.push([xx, run, xx, y]);
            run = -1;
          }
        }
      }
    }
    this.edges = E;
  }

  newStage(stage: number) {
    this.stage = stage;
    this.rng = mulberry(this.seed * 7919 + stage * 1013);
    this.buildMaze();
    this.pellet.fill(0);
    this.pelletsLeft = 0;
    const W = this.W;
    const corners: [number, number][] = [[1, 3], [W - 2, 3], [1, this.H - 4], [W - 2, this.H - 4]];
    for (let i = 0; i < W * this.H; i++) {
      const x = i % W;
      const y = (i / W) | 0;
      if (this.map[i] !== OPEN) continue;
      if (Math.abs(x - this.penX) <= 4 && Math.abs(y - this.penY) <= 4) continue; // the ring around the pen starts dark
      if (x === this.startX && y === this.startY) continue;
      this.pellet[i] = 1;
      this.pelletsLeft++;
    }
    for (const [x, y] of corners) {
      // nearest open tile to the corner
      let best = -1;
      let bd = 1e9;
      for (let i = 0; i < W * this.H; i++) {
        if (this.pellet[i] === 0) continue;
        const d = Math.abs((i % W) - x) + Math.abs(((i / W) | 0) - y);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) this.pellet[best] = 2;
    }
    this.pelletsTotal = this.pelletsLeft;
    this.tileLum.fill(0);
    this.lights = [];
    this.sparks = [];
    this.charge = 0;
    this.stageTime = 0;
    this.mapVersion = ++MAP_SERIAL;
    this.resetActors();
    this.onStage(stage);
  }

  private resetActors() {
    this.p = { tx: this.startX, ty: this.startY, dir: -1, t: 0 };
    this.input.want = -1;
    this.face = 2;
    const n = Math.min(T.GHOSTS_MAX, T.GHOSTS_BASE + this.stage - 1);
    this.ghosts = [];
    for (let i = 0; i < n; i++) {
      const slot = i % 4;
      this.ghosts.push({
        id: i, tx: this.penX - 1 + (slot % 3), ty: this.penY + (slot === 3 ? 1 : 0), dir: -1, t: 0,
        state: "pen", wait: 1 + i * T.GHOST_RELEASE_SEC, hp: 1, burn: 0, lum: 0, c: GHOST_C[i % 4], slot, flash: 0, burnedBy: 0, blow: 0, blowAt: -1,
      });
    }
  }

  burstMin() {
    return Math.round(this.knobs.chargeMax / 6);
  }

  ghostSpeed() {
    const dark = 1 - this.pelletsLeft / Math.max(1, this.pelletsTotal);
    return Math.min(T.GHOST_SPEED_MAX, T.GHOST_SPEED + T.GHOST_SPEED_DARK * dark + T.GHOST_SPEED_PER_STAGE * (this.stage - 1));
  }

  // advance a mover along the grid; decide() is called on arriving at a tile center (or while stopped)
  private advance(m: Mover, dist: number, decide: (m: Mover) => number) {
    for (let guard = 0; guard < 8 && dist > 1e-6; guard++) {
      if (m.dir < 0) {
        const nd = decide(m);
        if (nd < 0) return;
        m.dir = nd;
        m.t = 0;
      }
      const step = Math.min(dist, 1 - m.t);
      m.t += step;
      dist -= step;
      if (m.t >= 1 - 1e-6) {
        m.tx += DX[m.dir];
        m.ty += DY[m.dir];
        m.t = 0;
        const nd = decide(m);
        if (nd < 0) { m.dir = -1; return; }
        m.dir = nd;
      }
    }
  }

  private playerDecide(m: Mover) {
    const w = this.input.want;
    if (w >= 0 && this.playerOk(m.tx + DX[w], m.ty + DY[w])) return w;
    if (m.dir >= 0 && this.playerOk(m.tx + DX[m.dir], m.ty + DY[m.dir])) return m.dir;
    return -1;
  }

  lumAt(x: number, y: number) {
    return this.tileLum[y * this.W + x];
  }

  private ghostDecide(g: Ghost): number {
    const opts: number[] = [];
    for (let d = 0; d < 4; d++) if (this.ghostOk(g, g.tx + DX[d], g.ty + DY[d])) opts.push(d);
    if (!opts.length) return -1;
    const W = this.W;
    if (g.state === "leave" || g.state === "eyes") {
      const D = g.state === "leave" ? this.distExit : this.distPen;
      if (D[g.ty * W + g.tx] === 0) return -1;
      let best = -1;
      let bd = 1e9;
      for (const d of opts) {
        const v = D[(g.ty + DY[d]) * W + g.tx + DX[d]];
        if (v >= 0 && v < bd) { bd = v; best = d; }
      }
      return best;
    }
    // out: strong light is a wall (caught in it -> flee to the darkest neighbor, reverse allowed)
    const WL = T.GHOST_WALL;
    const here = this.lumAt(g.tx, g.ty);
    const L = (d: number) => this.lumAt(g.tx + DX[d], g.ty + DY[d]);
    if (here >= WL) {
      let best = opts[0];
      for (const d of opts) if (L(d) < L(best)) best = d;
      return L(best) < here ? best : -1;
    }
    const ok = opts.filter((d) => L(d) < WL);
    if (!ok.length) return -1; // hesitate at the edge of the strong light
    const fwd = ok.filter((d) => g.dir < 0 || d !== REV[g.dir]);
    const cand = fwd.length ? fwd : ok;
    let best = -1;
    if (this.rng() < T.GHOST_WANDER) best = cand[Math.floor(this.rng() * cand.length)];
    else {
      let bd = 1e9;
      for (const d of cand) {
        const v = this.distRoad[(g.ty + DY[d]) * W + g.tx + DX[d]];
        if (v >= 0 && v < bd) { bd = v; best = d; }
      }
      if (best < 0) {
        // no road to the player (walled by strong light): drift toward them anyway, a bit at random
        const [px, py] = this.near(this.p);
        let bs = -1e9;
        for (const d of cand) {
          const s = -Math.hypot(g.tx + DX[d] - px, g.ty + DY[d] - py) + this.rng() * 3;
          if (s > bs) { bs = s; best = d; }
        }
      }
    }
    // a lit pellet ahead: stop and blow it out first
    const ni = (g.ty + DY[best]) * W + g.tx + DX[best];
    if (this.pellet[ni] === 1) {
      g.blow = this.knobs.blowSec;
      g.blowAt = ni;
      return -1;
    }
    return best;
  }

  burst() {
    if (this.charge < this.burstMin()) return false;
    const k = this.charge / T.CHARGE_REF;
    const kg = Math.pow(k, T.BURST_GAMMA);
    const [x, y] = this.pos(this.p);
    const wx = x * T.TILE;
    const wy = y * T.TILE;
    this.lights.push({ x: wx, y: wy, r: 3 + T.BURST_R * k, e: T.BURST_E_MIN + (T.BURST_E - T.BURST_E_MIN) * kg, life: T.BURST_SEC, max: T.BURST_SEC, c: BURST_C, kind: "flash" });
    this.lights.push({ x: wx, y: wy, r: 3, e: T.EMBER_E * Math.max(0.35, k), life: T.EMBER_SEC * Math.max(0.35, k), max: T.EMBER_SEC * Math.max(0.35, k), c: POWER_C, kind: "ember" });
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const v = 80 + 160 * k;
      this.sparks.push({ x: wx, y: wy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.4, max: 0.4, c: [1, 0.85, 0.55] });
    }
    this.charge = 0;
    this.bursts++;
    this.burstSerial++;
    this.burstChain = 0;
    this.lastBurstT = this.time;
    this.shake = Math.max(this.shake, 3 + 6 * k);
    this.hitstop = T.HITSTOP;
    return true;
  }

  update(dt: number) {
    if (this.paused || this.over) return;
    dt = Math.min(dt, 1 / 20);
    this.time += dt;
    this.shake *= Math.pow(0.002, dt);
    for (const l of this.lights) l.life -= dt;
    this.lights = this.lights.filter((l) => l.life > 0);
    for (const s of this.sparks) {
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= Math.pow(0.05, dt);
      s.vy *= Math.pow(0.05, dt);
    }
    this.sparks = this.sparks.filter((s) => s.life > 0);
    if (this.hitstop > 0) { this.hitstop -= dt; return; }
    if (this.dying > 0) {
      this.dying -= dt;
      if (this.dying <= 0) {
        if (this.lives <= 0) this.over = true;
        else this.resetActors();
      }
      return;
    }
    if (this.clearing > 0) {
      this.clearing -= dt;
      if (this.clearing <= 0) this.newStage(this.stage + 1);
      return;
    }
    this.stageTime += dt;

    // player
    const I = this.input;
    const p = this.p;
    if (I.want >= 0 && p.dir >= 0 && I.want === REV[p.dir]) {
      // reverse at once, mid-tile
      if (p.t < 1e-6) p.dir = -1;
      else {
        p.tx += DX[p.dir];
        p.ty += DY[p.dir];
        p.t = 1 - p.t;
        p.dir = I.want;
      }
    }
    const ahead = p.dir >= 0 ? this.pellet[(p.ty + DY[p.dir]) * this.W + p.tx + DX[p.dir]] : 0;
    this.advance(p, T.PLAYER_SPEED * (ahead ? T.PLAYER_EAT_SLOW : 1) * dt, (m) => this.playerDecide(m));
    if (p.dir >= 0) this.face = p.dir;
    this.mouth += dt * (p.dir >= 0 ? 14 : 0);
    {
      const [nx, ny] = this.near(p);
      const i = ny * this.W + nx;
      if (this.pellet[i]) {
        const kind = this.pellet[i];
        const pw = kind === 2;
        this.pellet[i] = 0;
        this.pelletsLeft--;
        this.score += pw ? T.SCORE_POWER : T.SCORE_PELLET;
        this.charge = Math.min(this.knobs.chargeMax, this.charge + (pw ? T.CHARGE_PER_POWER : kind === 3 ? T.CHARGE_PER_DARK : T.CHARGE_PER_PELLET));
        if (pw) this.onToast("おおきな ひかり! ともしびが まんたん", "#ffd890");
        if (this.pelletsLeft <= 0) {
          this.clearing = T.CLEAR_SEC;
          this.score += 500 * this.stage;
          this.onToast(`ステージ ${this.stage} クリア!`, "#ffd890");
        }
      }
    }
    if (I.burst) { I.burst = false; this.burst(); }

    // road distances from the player, over tiles the ghosts can walk (anything below strong light)
    {
      const [px, py] = this.near(p);
      this.bfs([[px, py]], (x, y) => this.tile(x, y) === OPEN && this.lumAt(x, y) < T.GHOST_WALL, this.distRoad);
    }

    // ghosts
    const gs = this.ghostSpeed();
    const [ppx, ppy] = this.pos(p);
    for (const g of this.ghosts) {
      g.flash -= dt;
      if (g.state === "pen") {
        g.wait -= dt;
        if (g.wait <= 0) { g.state = "leave"; g.dir = -1; g.t = 0; g.hp = 1; }
        continue;
      }
      if (g.state === "eyes") {
        this.advance(g, T.GHOST_EYES_SPEED * dt, (m) => this.ghostDecide(m as Ghost));
        if (g.tx === this.penX && g.ty === this.penY && g.t === 0) { g.state = "pen"; g.wait = T.GHOST_RESPAWN_SEC; g.dir = -1; }
        continue;
      }
      if (g.state === "leave") {
        this.advance(g, gs * 0.6 * dt, (m) => this.ghostDecide(m as Ghost));
        if (g.tx === this.exitX && g.ty === this.exitY) { g.state = "out"; }
        continue;
      }
      // out: burn in light
      const B = T.GHOST_BURN;
      g.burn = smooth(B, T.GHOST_BURN_FULL, g.lum);
      if (g.burn > 0.01) {
        g.hp -= T.GHOST_BURN_DPS * g.burn * dt;
        g.flash = 0.05;
        if (g.hp <= 0) { this.burnOut(g); continue; }
      } else g.hp = Math.min(1, g.hp + dt * 0.3);
      if (g.blow > 0) {
        g.blow -= dt;
        if (g.blow <= 0 && this.pellet[g.blowAt] === 1) this.blowOut(g.blowAt);
        const [gx, gy] = this.pos(g);
        if (g.lum < T.GHOST_WALL && Math.hypot(gx - ppx, gy - ppy) < T.HIT_DIST) { this.die(); break; } // inside strong light it is busy burning
        continue;
      }
      // strong light appeared on the tile ahead while on the way: back off instead of walking in
      if (g.dir >= 0 && g.t < 0.5) {
        const ax = g.tx + DX[g.dir];
        const ay = g.ty + DY[g.dir];
        if (this.lumAt(ax, ay) >= T.GHOST_WALL && this.lumAt(ax, ay) > this.lumAt(g.tx, g.ty)) {
          g.tx = ax;
          g.ty = ay;
          g.t = 1 - g.t;
          g.dir = REV[g.dir];
        }
      }
      const sp = gs * (g.lum >= T.GHOST_FEAR ? this.knobs.lightSlow : 1) * (1 - (1 - T.GHOST_SLOW_IN_LIGHT) * g.burn);
      this.advance(g, sp * dt, (m) => this.ghostDecide(m as Ghost));
      const [gx, gy] = this.pos(g);
      if (g.lum < T.GHOST_WALL && Math.hypot(gx - ppx, gy - ppy) < T.HIT_DIST) { this.die(); break; } // inside strong light it is busy burning
    }
  }

  blowOut(i: number) {
    this.pellet[i] = 3;
    this.blown++;
    const x = ((i % this.W) + 0.5) * T.TILE;
    const y = (((i / this.W) | 0) + 0.5) * T.TILE;
    for (let k = 0; k < 6; k++) {
      const a = this.rng() * Math.PI * 2;
      this.sparks.push({ x, y, vx: Math.cos(a) * 25, vy: Math.sin(a) * 25 - 20, life: 0.6, max: 0.6, c: [0.45, 0.42, 0.5] });
    }
  }

  private burnOut(g: Ghost) {
    g.blow = 0;
    g.state = "eyes";
    g.burn = 0;
    const chain = this.time - this.lastBurstT < T.BURST_SEC + 1;
    const pts = chain ? T.SCORE_GHOST * Math.pow(2, this.burstChain++) : T.SCORE_GHOST;
    this.score += pts;
    this.burned++;
    const [x, y] = this.pos(g);
    for (let i = 0; i < 14; i++) {
      const a = this.rng() * Math.PI * 2;
      const v = 30 + this.rng() * 120;
      this.sparks.push({ x: x * T.TILE, y: y * T.TILE, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.5 + this.rng() * 0.4, max: 0.9, c: PURPLE });
    }
    this.onToast(`おばけが やけた +${pts}`, "#c79bff");
    // snap to the nearer tile so the eyes walk the grid home
    const [nx, ny] = this.near(g);
    g.tx = nx; g.ty = ny; g.t = 0; g.dir = -1;
  }

  die() {
    this.lives--;
    this.deaths++;
    this.dying = T.DEATH_SEC;
    this.shake = 8;
    this.charge = Math.floor(this.charge / 2);
    const [x, y] = this.pos(this.p);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      this.sparks.push({ x: x * T.TILE, y: y * T.TILE, vx: Math.cos(a) * 90, vy: Math.sin(a) * 90, life: 0.9, max: 0.9, c: [1, 0.8, 0.4] });
    }
  }

  // world px per canvas px so the whole maze fits with a margin (and room for the HUD at the top)
  fit(cw: number, ch: number, hudPx: number) {
    const pad = T.VIEW_PAD * T.TILE;
    return Math.max((this.W * T.TILE + pad * 2) / cw, (this.H * T.TILE + pad * 2) / Math.max(1, ch - hudPx));
  }

  frame(cw: number, ch: number, wpp: number, hudPx: number): Frame {
    const R = this.rng;
    const t = this.time;
    const TL = T.TILE;
    const viewW = cw * wpp;
    const viewH = ch * wpp;
    const hudW = hudPx * wpp;
    const camX = (this.W * TL) / 2 - viewW / 2 + (R() - 0.5) * this.shake;
    const camY = (this.H * TL) / 2 - (viewH - hudW) / 2 - hudW + (R() - 0.5) * this.shake;
    const S = this.scene;
    const L = this.lit;
    const G = this.glow;
    S.reset();
    L.reset();
    G.reset();
    let lights = 0;
    const em = (x: number, y: number, r: number, c: V3, e: number) => {
      S.circle(x, y, r, c[0] * e, c[1] * e, c[2] * e, 1);
      lights++;
    };
    const W = this.W;

    // wall outline (display only)
    for (const [x0, y0, x1, y1] of this.edges) G.line(x0 * TL, y0 * TL, x1 * TL, y1 * TL, 0.5, 0.25, 0.45, 1, T.OUTLINE_A, 2);
    {
      const k = 0.6 + 0.4 * Math.sin(t * 3);
      G.line((this.penX - 0.45) * TL, (this.penY - 2.5) * TL, (this.penX + 0.45) * TL, (this.penY - 2.5) * TL, 1, 1, 0.5, 0.8, 0.5 * k, 2);
    }
    // pellets
    for (let i = 0; i < W * this.H; i++) {
      const v = this.pellet[i];
      if (!v) continue;
      const x = ((i % W) + 0.5) * TL;
      const y = (((i / W) | 0) + 0.5) * TL;
      if (v === 3) {
        G.circle(x, y, T.PELLET_R * 0.8, 0.35, 0.33, 0.4, 0.7, 1);
      } else if (v === 1) {
        em(x, y, T.PELLET_R, PELLET_C, T.PELLET_E);
        G.circle(x, y, T.PELLET_R * 0.7, 1, 0.9, 0.7, 0.8, 2);
      } else {
        const k = 0.8 + 0.2 * Math.sin(t * 4 + i);
        em(x, y, T.POWER_R, POWER_C, T.POWER_E * k);
        G.circle(x, y, T.POWER_R * 0.8, 1, 0.8, 0.5, 0.9, 6);
      }
    }
    for (const l of this.lights) {
      const k = l.life / l.max;
      if (l.kind === "flash") {
        em(l.x, l.y, l.r, l.c, l.e * Math.min(1, k * 2));
        G.circle(l.x, l.y, l.r, 1, 0.9, 0.7, 0.8 * k, l.r * 1.5);
      } else {
        em(l.x, l.y, l.r, l.c, l.e * Math.pow(k, 0.6));
        G.circle(l.x, l.y, 2, 1, 0.7, 0.4, 0.7 * k, 4);
      }
    }
    for (const s of this.sparks) {
      const k = s.life / s.max;
      G.circle(s.x, s.y, 1, s.c[0], s.c[1], s.c[2], k, 2.5);
    }

    // light probes: every walkable tile center, then each ghost's own spot
    this.probeKeys = [];
    let pc = 0;
    for (let i = 0; i < W * this.H && pc < PROBE_N; i++) {
      if (this.map[i] === WALL) continue;
      this.probes[pc * 2] = ((i % W) + 0.5) * TL;
      this.probes[pc * 2 + 1] = (((i / W) | 0) + 0.5) * TL;
      this.probeKeys.push(i);
      pc++;
    }
    this.ghosts.forEach((g, k) => {
      if (pc >= PROBE_N) return;
      const [x, y] = this.pos(g);
      this.probes[pc * 2] = x * TL;
      this.probes[pc * 2 + 1] = y * TL;
      this.probeKeys.push(-1 - k);
      pc++;
    });
    this.probeSerial++;
    this.pendingProbe.set(this.probeSerial, this.probeKeys);
    if (this.pendingProbe.size > 8) this.pendingProbe.delete(this.pendingProbe.keys().next().value!);

    // ghosts: lit bodies (invisible in the dark), glowing eyes
    for (const g of this.ghosts) {
      const [gx, gy] = this.pos(g);
      const x = gx * TL;
      const y = (gy + (g.state === "pen" ? Math.sin(t * 4 + g.id) * 0.12 : 0)) * TL;
      const r = TL * 0.42;
      const fx = (g.flash > 0 ? 1.5 : 0) + this.knobs.see * 0.45;
      if (g.state !== "eyes") {
        if (g.burn > 0.05) G.circle(x, y, r, 0.7, 0.3, 1, 0.6 * g.burn, 8);
        if (this.knobs.see > 0) G.circle(x, y, r * 0.9, g.c[0], g.c[1], g.c[2], 0.12 * this.knobs.see, 5);
        L.circle(x, y - r * 0.2, r * 0.8, g.c[0] * 0.6, g.c[1] * 0.6, g.c[2] * 0.6, 0.95, 0, fx);
        L.push(x, y + r * 0.35, r * 0.8, r * 0.45, 0, 1, 0, fx, g.c[0] * 0.6, g.c[1] * 0.6, g.c[2] * 0.6, 0.95);
        for (let k = -1; k <= 1; k++) L.circle(x + k * r * 0.55, y + r * 0.8 + Math.sin(t * 10 + k + g.id) * 1, r * 0.22, g.c[0] * 0.6, g.c[1] * 0.6, g.c[2] * 0.6, 0.95, 0, fx);
      }
      const d = g.dir < 0 ? 1 : g.dir;
      const ex = DX[d] * 2;
      const ey = DY[d] * 2;
      for (const s of [-1, 1]) {
        G.circle(x + s * r * 0.35, y - r * 0.25, 2.3, 0.9, 0.9, 1, g.state === "eyes" ? 1 : 0.55, 1.5);
        G.circle(x + s * r * 0.35 + ex, y - r * 0.25 + ey, 1.1, g.c[0], g.c[1] * 0.3, g.c[2] * 0.4, 1, 2);
      }
    }

    // player: a round ともしび with a mouth; its halo grows with the stored charge (display only)
    if (!(this.dying > 0 && Math.floor(t * 12) % 2 === 0)) {
      const [px, py] = this.pos(this.p);
      const x = px * TL;
      const y = py * TL;
      const r = TL * 0.4;
      const ck = Math.min(1, this.charge / T.CHARGE_REF);
      L.circle(x, y, r, 1, 0.85, 0.4, 1, 0, 0.6 + ck * 1.2);
      const open = 0.5 + 0.5 * Math.sin(this.mouth);
      const f = this.face;
      L.circle(x + DX[f] * r * 0.75, y + DY[f] * r * 0.75, r * 0.5 * open, 0, 0, 0, 1);
      G.circle(x, y, r * 0.8, 1, 0.75, 0.35, 0.25 + 0.5 * ck, 4 + 10 * ck);
      if (this.charge >= this.burstMin()) G.circle(x, y, r + 3 + 2 * Math.sin(t * 6), 1, 0.85, 0.5, 0.25 + 0.35 * ck, 2);
    }

    this.lightCount = lights;
    return {
      camX, camY, wpp,
      map: this.map, mapW: this.W, mapH: this.H, tile: TL, mapVersion: this.mapVersion,
      scene: S, lit: L, glow: G, probes: this.probes, probeCount: pc,
      view: 0, time: t, exposure: T.EXPOSURE, ambient: T.AMBIENT, bounce: T.BOUNCE, fog: T.FOG, gameFog: T.FOG, gameBounce: T.BOUNCE, toe: T.TONE_TOE, shake: this.shake,
    };
  }

  applyLum(serial: number, lum: Float32Array, n: number) {
    const keys = this.pendingProbe.get(serial);
    if (!keys) return;
    for (let i = 0; i < Math.min(n, keys.length); i++) {
      const k = keys[i];
      if (k >= 0) this.tileLum[k] = lum[i];
      else {
        const g = this.ghosts[-1 - k];
        if (g) g.lum = lum[i];
      }
    }
    this.lumSerialSeen = serial;
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
