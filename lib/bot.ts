// A plain test player for check.mjs (difficulty / stuck / determinism gauge, not a fun score):
// walk to the nearest pellet avoiding tiles near ghosts, release the stored light when a ghost gets close.
import { Game, DX, DY, OPEN } from "./game";
import { T } from "./tuning";

let stuck = 0;

export function botStep(g: Game, opts = { danger: 2, burstAt: 3.5, dt: 1 / 30 }) {
  const W = g.W;
  const H = g.H;
  const [px, py] = g.near(g.p);
  const [ppx, ppy] = g.pos(g.p);
  const out = g.ghosts.filter((e) => e.state === "out");
  let close = 1e9;
  for (const e of out) {
    const [x, y] = g.pos(e);
    close = Math.min(close, Math.hypot(x - ppx, y - ppy));
  }
  if (close < opts.burstAt && g.charge >= T.BURST_MIN) g.input.burst = true;
  const danger = new Uint8Array(W * H);
  for (const e of out) {
    const [ex, ey] = g.near(e);
    const d = g.bfs([[ex, ey]], (x, y) => g.tile(x, y) === OPEN);
    for (let i = 0; i < W * H; i++) if (d[i] >= 0 && d[i] <= opts.danger) danger[i] = 1;
  }
  const first = (avoid: boolean) => {
    const prev = new Int32Array(W * H).fill(-1);
    const q = [py * W + px];
    prev[q[0]] = q[0];
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      if (g.pellet[i] && i !== q[0]) {
        let j = i;
        while (prev[j] !== q[0]) j = prev[j];
        const dx = (j % W) - px;
        const dy = ((j / W) | 0) - py;
        return dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
      }
      const x = i % W;
      const y = (i / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        const j = ny * W + nx;
        if (g.tile(nx, ny) !== OPEN || prev[j] >= 0 || (avoid && danger[j])) continue;
        prev[j] = i;
        q.push(j);
      }
    }
    return -1;
  };
  let dir = first(true);
  stuck = dir < 0 ? stuck + opts.dt : 0;
  // no safe road: push through anyway with a light to release, or after dithering for a while
  if (dir < 0 && (g.charge >= T.BURST_MIN || stuck > 5)) dir = first(false);
  if (dir < 0) {
    // cornered: step to the neighbor farthest from the ghosts
    let best = -1e9;
    for (let k = 0; k < 4; k++) {
      const nx = px + DX[k];
      const ny = py + DY[k];
      if (g.tile(nx, ny) !== OPEN) continue;
      let m = 1e9;
      for (const e of out) {
        const [x, y] = g.pos(e);
        m = Math.min(m, Math.hypot(x - nx - 0.5, y - ny - 0.5));
      }
      if (m > best) { best = m; dir = k; }
    }
  }
  if (dir < 0) dir = first(false);
  g.input.want = dir;
}
