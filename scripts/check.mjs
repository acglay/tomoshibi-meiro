// Numeric checks for the M0: node scripts/check.mjs [url] [games]
// (a) eating pellets lowers lightAt around them (b) light vs ghosts: waiting without eating, ghosts blow out pellets
// and come (no locking them in); slower in pellet light; a burst burns; in the dark a ghost closes in (c) GPU time does not follow the pellet count
// (d) bot games: clear rate, survival time (difficulty / stuck gauge, not a fun score)
import { chromium } from "file:///Z:/Claude/_tools/node_modules/playwright/index.mjs";

const url = process.argv[2] || "http://localhost:3395";
const games = Number(process.argv[3] || 30);
const browser = await chromium.launch({ args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url + "/#seed=7&play&tier=3");
await page.waitForTimeout(2000);

await page.evaluate(() => {
  const G = window.game;
  const g = G.g;
  window.H = {
    G, g,
    wait: (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    med: (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; },
    pct: (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; },
    r2: (v) => Math.round(v * 100) / 100,
    c: (x, y) => [(x + 0.5) * 24, (y + 0.5) * 24],
    open: (x, y) => g.tile(x, y) === 0,
    N4: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  };
});

const out = {};
out.stats = await page.evaluate(() => window.game.stats());

// (a) walk the player along a straight run of 4 pellets; light on the eaten tiles and beside them, before/after
out.a = await page.evaluate(async () => {
  const { G, g, wait, r2, c, open } = window.H;
  g.ghosts.forEach((e) => { e.state = "pen"; e.wait = 1e9; });
  let row = -1, x0 = -1;
  for (let y = 1; y < g.H - 1 && row < 0; y++) for (let x = 1; x < g.W - 5; x++) {
    if (open(x, y) && [1, 2, 3, 4].every((k) => g.pellet[y * g.W + x + k] === 1)) { row = y; x0 = x; break; }
  }
  const eat = [1, 2, 3, 4].map((k) => [x0 + k, row]);
  const side = eat.map(([x, y]) => (open(x, y - 1) ? [x, y - 1] : open(x, y + 1) ? [x, y + 1] : [x, y]));
  const pts = eat.map(([x, y]) => c(x, y)).concat(side.map(([x, y]) => c(x, y)));
  g.p = { tx: x0, ty: row, dir: -1, t: 0 };
  g.input.want = -1;
  await wait(10);
  const before = G.lightAt(pts, "game");
  const charge0 = g.charge;
  g.input.want = 0;
  for (let i = 0; i < 120 && eat.some(([x, y]) => g.pellet[y * g.W + x]); i++) await wait(1);
  g.paused = true;
  await wait(8);
  const after = G.lightAt(pts, "game");
  g.paused = false;
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  return {
    run: [x0 + 1, row], eaten: eat.every(([x, y]) => g.pellet[y * g.W + x] === 0), chargeGained: g.charge - charge0,
    onEaten: { before: before.slice(0, 4).map(r2), after: after.slice(0, 4).map(r2) },
    beside: { tiles: side, before: before.slice(4).map(r2), after: after.slice(4).map(r2) },
    ratioOnEaten: r2(sum(after.slice(0, 4)) / sum(before.slice(0, 4))),
  };
});

// (b) light vs ghosts
out.b = await page.evaluate(async () => {
  const { G, g, wait, sleep, r2, open, N4 } = window.H;
  const W = g.W;
  const res = {};
  G.newGame(7);
  g.lives = 99;
  g.ghosts.forEach((e) => { e.state = "pen"; e.wait = 1e9; });
  // b1: the player just waits at the start without eating. Ghosts must blow their way out of the lit maze and catch
  // them (this used to be "never": pellets were walls). Same run: ghost speed in dark vs dim (pellet) light, and how
  // often an out ghost stood on strong light (>= GHOST_WALL, should be 0 without bursts)
  {
    window.__hold = true;
    G.newGame(7);
    g.lives = 99;
    g.input.want = -1;
    const dt = 1 / 30;
    let t = 0, firstOut = -1, caught = -1, wallTicks = 0, outTicks = 0, burnTicks = 0;
    const sp = { dark: [0, 0], dim: [0, 0] };
    const prev = g.ghosts.map((q) => g.pos(q));
    while (t < 120 && caught < 0) {
      G.step(1, dt);
      t += dt;
      g.ghosts.forEach((q, k) => {
        const p = g.pos(q);
        if (q.state === "out") {
          outTicks++;
          if (firstOut < 0) firstOut = t;
          const [nx, ny] = g.near(q);
          if (g.lumAt(nx, ny) >= 4) wallTicks++;
          if (q.burn > 0.01) burnTicks++;
          if (q.blow <= 0) {
            const band = q.lum >= 0.4 ? "dim" : "dark";
            sp[band][0] += Math.hypot(p[0] - prev[k][0], p[1] - prev[k][1]);
            sp[band][1] += dt;
          }
        }
        prev[k] = p;
      });
      if (g.deaths > 0) caught = t;
    }
    window.__hold = false;
    res.idle = {
      firstOutSec: r2(firstOut), caughtSec: caught < 0 ? null : r2(caught), blownOut: g.blown, pelletsLeft: g.pelletsLeft,
      speedTilesPerSec: { dark: r2(sp.dark[0] / Math.max(1e-6, sp.dark[1])), dim: r2(sp.dim[0] / Math.max(1e-6, sp.dim[1])), darkSec: r2(sp.dark[1]), dimSec: r2(sp.dim[1]) },
      onStrongLightTicks: wallTicks, burnTicksWithoutBurst: burnTicks, outTicks,
    };
  }
  G.newGame(7);
  g.lives = 99;
  g.ghosts.forEach((q) => { q.state = "pen"; q.wait = 1e9; });
  let spot = null;
  for (let i = 0; i < W * g.H && !spot; i++) {
    const x = i % W, y = (i / W) | 0;
    if (g.pellet[i] !== 1) continue;
    const nb = N4.filter(([dx, dy]) => open(x + dx, y + dy));
    if (nb.length >= 2 && nb.every(([dx, dy]) => g.pellet[(y + dy) * W + x + dx] === 1)) spot = [x, y];
  }
  const [sx, sy] = spot;
  g.pellet[sy * W + sx] = 0;
  g.pelletsLeft--;
  const e = g.ghosts[0];
  Object.assign(e, { state: "out", tx: sx, ty: sy, dir: -1, t: 0, hp: 1 });
  await wait(6);
  // b2: the player stands right next to it and releases a full charge
  const nb = N4.find(([dx, dy]) => open(sx + dx, sy + dy));
  g.pellet[(sy + nb[1]) * W + sx + nb[0]] = 0;
  g.pelletsLeft--;
  g.p = { tx: sx + nb[0], ty: sy + nb[1], dir: -1, t: 0 };
  g.input.want = -1;
  const lives0 = g.lives;
  g.charge = 30;
  g.input.burst = true;
  let t = 0, lumMax = 0;
  while (e.state === "out" && t < 3000) { await sleep(50); t += 50; lumMax = Math.max(lumMax, e.lum); }
  res.burst = { burnedOut: e.state !== "out", seconds: t / 1000, lumMax: r2(lumMax), livesLost: lives0 - g.lives };
  // b3: in the dark (every pellet gone but one), an out ghost 10-14 steps away closes in and catches the player
  {
    G.newGame(7);
    g.lives = 99;
    const keep = g.pellet.findIndex((v) => v);
    for (let i = 0; i < W * g.H; i++) if (i !== keep) g.pellet[i] = 0;
    g.pelletsLeft = 1;
    g.ghosts.forEach((q) => { q.state = "pen"; q.wait = 1e9; });
    g.p = { tx: g.startX, ty: g.startY, dir: -1, t: 0 };
    g.input.want = -1;
    await wait(8);
    const d = g.bfs([[g.startX, g.startY]], (x, y) => g.tile(x, y) === 0);
    let far = -1;
    for (let i = 0; i < W * g.H; i++) if (d[i] >= 10 && d[i] <= 14) { far = i; break; }
    const q = g.ghosts[0];
    Object.assign(q, { state: "out", tx: far % W, ty: (far / W) | 0, dir: -1, t: 0, hp: 1, lum: 0 });
    const l0 = g.lives;
    const trace = [];
    let tt = 0;
    while (g.lives === l0 && tt < 6000) {
      const [nx, ny] = g.near(q);
      trace.push(d[ny * W + nx]);
      await sleep(250);
      tt += 250;
    }
    res.dark = { startSteps: trace[0], trace, caught: g.lives < l0, seconds: tt / 1000, ghostLum: r2(q.lum) };
  }
  return res;
});

// (c) GPU time with all pellets lit vs none, alternating (the GPU clock drifts more than the scenes differ)
out.c = await page.evaluate(async () => {
  const { G, g, wait, med, pct } = window.H;
  G.newGame(7);
  g.paused = true;
  const full = Uint8Array.from(g.pellet);
  const gpu = async () => {
    await wait(20);
    const s = [];
    let last = G.rc.gpuSerial;
    await new Promise((r) => {
      let n = 0;
      const f = () => {
        if (G.rc.gpuSerial !== last) { last = G.rc.gpuSerial; s.push(G.rc.gpuMs); }
        if (s.length >= 60 || ++n > 400) r(); else requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    });
    return { med: Math.round(med(s) * 100) / 100, p90: Math.round(pct(s, 0.9) * 100) / 100, lights: g.lightCount };
  };
  const rounds = [];
  for (let k = 0; k < 3; k++) {
    g.pellet.set(full);
    const a = await gpu();
    g.pellet.fill(0);
    const b = await gpu();
    rounds.push({ all: a.med, allP90: a.p90, allLights: a.lights, none: b.med, noneP90: b.p90, noneLights: b.lights });
  }
  g.pellet.set(full);
  g.paused = false;
  return { rounds, perf: G.stats().perf.name, rc: G.stats().rc };
});

// (d) bot games, fast-forwarded (1/30 s ticks, synchronous light readback): stage 1 (2 ghosts) and stage 3 (4 ghosts)
const bot = (games, stage) => page.evaluate(async ([games, stage]) => {
  const { G, g, sleep } = window.H;
  window.__hold = true;
  window.__bot = true;
  const res = [];
  const t0 = performance.now();
  for (let k = 0; k < games; k++) {
    G.newGame(1000 + k);
    if (stage > 1) g.newStage(stage);
    g.paused = false;
    const cap = 240 * 30;
    let n = 0;
    while (!g.over && n < cap && g.stage === stage) {
      G.step(60);
      n += 60;
      await sleep(0);
    }
    const cleared = g.stage > stage;
    res.push({ cleared, t: Math.round(g.time), deaths: g.deaths, eaten: cleared ? g.pelletsTotal : g.pelletsTotal - g.pelletsLeft, total: g.pelletsTotal, bursts: g.bursts, burned: g.burned, timeout: !cleared && !g.over });
  }
  window.__bot = false;
  window.__hold = false;
  const cl = res.filter((r) => r.cleared);
  const lost = res.filter((r) => !r.cleared && !r.timeout);
  const avg = (a) => (a.length ? Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 10) / 10 : null);
  return {
    stage, games, clearRate: Math.round((cl.length / games) * 100) + "%", timeouts: res.filter((r) => r.timeout).length,
    avgClearSec: avg(cl.map((r) => r.t)), avgSurvivalSecWhenLost: avg(lost.map((r) => r.t)), avgEatenPctWhenLost: avg(lost.map((r) => (100 * r.eaten) / r.total)),
    avgDeaths: avg(res.map((r) => r.deaths)), avgBursts: avg(res.map((r) => r.bursts)), avgBurned: avg(res.map((r) => r.burned)),
    wallSec: Math.round((performance.now() - t0) / 1000),
    each: res.map((r) => `${r.cleared ? "C" : r.timeout ? "T" : "x"}${r.t}s/d${r.deaths}/b${r.burned}`).join(" "),
  };
}, [games, stage]);
out.d = await bot(games, 1);
out.d3 = await bot(Math.max(5, Math.round(games / 3)), 3);

console.log(JSON.stringify(out, null, 1));
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
