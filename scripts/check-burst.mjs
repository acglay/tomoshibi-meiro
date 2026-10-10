// Why does a full burst fail? node scripts/check-burst.mjs [url]
// Real-time (async light readback, like real play): a ghost chases the player down the straight top corridor,
// d tiles behind; the player releases a full charge. Did the player die, did the ghost burn, how long it took.
import { chromium } from "file:///Z:/Claude/_tools/node_modules/playwright/index.mjs";
const url = process.argv[2] || "http://localhost:3395";
const b = await chromium.launch({ args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(url + "/#seed=7&play&tier=3");
await p.waitForTimeout(1500);
const r = await p.evaluate(async () => {
  const G = window.game, g = G.g;
  const frames = (n) => new Promise((res) => { let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const out = [];
  for (const d of [1, 2, 3, 4, 5]) {
    G.newGame(7);
    g.newStage(3); // the full-size maze: its top row is a long straight corridor
    g.lives = 99;
    g.pellet.fill(0); g.pellet[g.W * (g.H - 2) + g.W - 2] = 1; g.pelletsLeft = 1;
    g.ghosts.forEach((e) => { e.state = "pen"; e.wait = 1e9; });
    // the player walks right along y=1 from x=6; the ghost follows d tiles behind
    const e = g.ghosts[0];
    g.p = { tx: 6, ty: 1, dir: 0, t: 0 };
    g.input.want = 0;
    const gx = 6 - d;
    Object.assign(e, { state: "out", tx: gx, ty: 1, dir: 0, t: 0, hp: 1, lum: 0 });
    await frames(2);
    g.charge = g.knobs.chargeMax;
    g.input.burst = true;
    const t0 = performance.now();
    let burnedAt = -1, lumMax = 0;
    while (performance.now() - t0 < 1500) {
      await frames(1);
      lumMax = Math.max(lumMax, e.lum);
      if (burnedAt < 0 && e.state !== "out") burnedAt = performance.now() - t0;
      if (g.deaths > 0) break;
    }
    out.push({ behindTiles: d, died: g.deaths > 0, diedAtMs: g.deaths > 0 ? Math.round(performance.now() - t0) : null, burned: burnedAt >= 0, burnedAtMs: burnedAt >= 0 ? Math.round(burnedAt) : null, ghostLumMax: Math.round(lumMax * 10) / 10 });
  }
  return out;
});
r.forEach((x) => console.log(JSON.stringify(x)));
console.log("errors:", errs.length ? errs : "none");
await b.close();
