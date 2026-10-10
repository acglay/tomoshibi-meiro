// Puzzle stages: can a plain bot clear each one (= not stuck), and how hard was it? node scripts/check-puzzle.mjs [url]
// Puzzle ghosts and the bot are deterministic, so instead of repeats there are 3 bot styles (danger radius / burst range).
// Also: ghosts do not move during PUZZLE_GRACE, a burned ghost is gone, a death restarts the stage with all pellets back.
import { chromium } from "file:///Z:/Claude/_tools/node_modules/playwright/index.mjs";
const url = process.argv[2] || "http://localhost:3395";
const b = await chromium.launch({ args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
await p.goto(url + "/#seed=7&mode=puzzle&stage=1&play&tier=3");
await p.waitForTimeout(1500);
const r = await p.evaluate(async () => {
  const G = window.game, g = G.g;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  window.__hold = true;
  const out = { rules: {}, stages: [] };
  const n = 6;
  // rules: grace, death restarts the stage, a burned ghost is gone
  G.newGame(7, "puzzle", 3);
  const e = g.ghosts[0];
  const at0 = [e.tx, e.ty];
  G.step(30); // 1 s < grace
  out.rules.stillDuringGrace = e.tx === at0[0] && e.ty === at0[1];
  const total = g.pelletsTotal;
  g.p = { tx: e.tx, ty: e.ty, dir: -1, t: 0 };
  g.stageTime = 5;
  g.pellet[g.startY * g.W + g.startX + 1] = 0;
  G.step(2);
  G.step(60);
  out.rules.deathRestarts = { deaths: g.deaths, livesUnchanged: g.lives, pelletsBack: g.pelletsLeft === total, stage: g.stage };
  G.newGame(7, "puzzle", 2);
  g.stageTime = 5;
  const q = g.ghosts[0];
  g.p = { tx: q.tx - 1, ty: q.ty, dir: -1, t: 0 };
  g.charge = 30;
  g.input.burst = true;
  G.step(30);
  out.rules.burnedIsGone = { state: q.state, drawnGhosts: g.ghosts.filter((x) => x.state !== "gone").length };
  // bot styles
  const styles = { careful: { danger: 3, burstAt: 3.5 }, normal: { danger: 2, burstAt: 3.5 }, bold: { danger: 1, burstAt: 2.5 } };
  for (let s = 1; s <= n; s++) {
    const row = { stage: s };
    for (const [name, st] of Object.entries(styles)) {
      window.__botOpts = { ...st, dt: 1 / 30 };
      window.__bot = true;
      G.newGame(7, "puzzle", s);
      row.size = `${g.W}x${g.H}`;
      let t = 0;
      while (g.stage === s && !g.over && t < 120) { G.step(30); t += 1; await sleep(0); }
      row[name] = `${g.stage > s || g.allClear ? "C" : "x"} ${Math.round(g.time)}s 死${g.deaths} 焼${g.burned} 放${g.bursts}`;
    }
    out.stages.push(row);
  }
  window.__bot = false;
  window.__hold = false;
  return out;
});
console.log(JSON.stringify(r.rules));
r.stages.forEach((x) => console.log(JSON.stringify(x)));
console.log("errors:", errs.length ? errs.slice(0, 3) : "none");
await b.close();
