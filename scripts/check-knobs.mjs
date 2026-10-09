// Do the ⚙ knobs do what they say? node scripts/check-knobs.mjs [url]
// (1) ghost speed in pellet light vs the dark, per lightSlow / blowSec (fast-forward, sync light)
// (2) how far a full burst burns, per chargeMax (ghost 1..7 tiles down the straight top corridor)
import { chromium } from "file:///Z:/Claude/_tools/node_modules/playwright/index.mjs";
const url = process.argv[2] || "http://localhost:3395";
const b = await chromium.launch({ args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(url + "/#seed=7&play&tier=3");
await p.waitForTimeout(1500);
const r = await p.evaluate(() => {
  const G = window.game, g = G.g;
  window.__hold = true;
  const r2 = (v) => Math.round(v * 100) / 100;
  const out = { speed: [], burst: [] };
  // (1) the top row y=1 is a straight corridor x=1..17. Ghost at x=1 chases the player parked at x=17 for 8 s, 3 seeds averaged (ghosts take a random turn 15% of the time).
  const run1 = (lit, slow, blow, seed) => {
    G.newGame(seed);
    g.knobs.lightSlow = slow;
    g.knobs.blowSec = blow;
    g.lives = 99;
    if (!lit) { g.pellet.fill(0); g.pellet[g.W * 21 + 17] = 1; g.pelletsLeft = 1; }
    g.ghosts.forEach((e) => { e.state = "pen"; e.wait = 1e9; });
    g.p = { tx: 17, ty: 1, dir: -1, t: 0 };
    g.input.want = -1;
    const e = g.ghosts[0];
    Object.assign(e, { state: "out", tx: 1, ty: 1, dir: -1, t: 0, hp: 1, lum: 0 });
    g.pellet[g.W + 1] = 0;
    G.step(3);
    Object.assign(e, { tx: 1, ty: 1, dir: -1, t: 0 });
    const x0 = g.pos(e)[0];
    let t = 0;
    while (t < 8 && g.deaths === 0) { G.step(1); t += 1 / 30; }
    return { v: (g.pos(e)[0] - x0) / t, blown: g.blown };
  };
  const run = (lit, slow, blow) => {
    const rs = [7, 8, 9].map((sd) => run1(lit, slow, blow, sd));
    return { lit, lightSlow: slow, blowSec: blow, tilesPerSec: r2(rs.reduce((a, q) => a + q.v, 0) / 3), blownOut: rs.map((q) => q.blown).join("/") };
  };
  out.speed.push(run(false, 0.45, 0.5));
  for (const [s, bl] of [[0.7, 0.5], [0.45, 0.5], [0.2, 0.5], [0.45, 0.25], [0.45, 1]]) out.speed.push(run(true, s, bl));
  // (2) full burst reach per container size
  for (const cm of [15, 30, 60]) {
    const row = [];
    for (let d = 1; d <= 7; d++) {
      G.newGame(7);
      g.knobs.chargeMax = cm;
      g.pellet.fill(0); g.pellet[g.W * 21 + 17] = 1; g.pelletsLeft = 1; g.lives = 99;
      g.ghosts.forEach((e) => { e.state = "pen"; e.wait = 1e9; });
      g.p = { tx: 1, ty: 1, dir: -1, t: 0 };
      g.input.want = -1;
      const e = g.ghosts[0];
      Object.assign(e, { state: "out", tx: 1 + d, ty: 1, dir: -1, t: 0, hp: 1, lum: 0 });
      G.step(2);
      Object.assign(e, { tx: 1 + d, ty: 1, dir: -1, t: 0 });
      g.charge = cm;
      g.input.burst = true;
      let t = 0, burned = false;
      while (t < 2 && !burned) { G.step(1); t += 1 / 30; burned = e.state !== "out"; }
      row.push(burned);
    }
    out.burst.push({ chargeMax: cm, burstMin: g.burstMin(), burnsUpTo: row.lastIndexOf(true) + 1, row: row.map((v) => (v ? "x" : ".")).join("") });
  }
  window.__hold = false;
  return out;
});
console.log(JSON.stringify(r, null, 1));
console.log("errors:", errs.length ? errs : "none");
await b.close();
