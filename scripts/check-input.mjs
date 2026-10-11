// Controls: node scripts/check-input.mjs [url]
// (1) stick: press on the left side, drag -> a direction while held, flick across -> switches, release -> none
// (2) keys: a direction only while held; with two held, letting go of one falls back to the other
// (3) the stick is drawn (rest / held) on touch devices
// (4) no unintended turn: running past a side branch with nothing held keeps the row (used to turn by a remembered swipe)
import { chromium } from "file:///Z:/Claude/_tools/node_modules/playwright/index.mjs";
const url = process.argv[2] || "http://localhost:3395";
const b = await chromium.launch({ args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(url + "/#seed=7&mode=puzzle&stage=3&play&tier=3");
await p.waitForTimeout(1500);
const want = () => p.evaluate(() => window.game.g.input.want);
const out = {};
await p.evaluate(() => { const g = window.game.g; g.ghosts = []; g.paused = true; });

out.stickAtRest = await p.evaluate(() => { const j = document.querySelector(".joy"); return j ? j.className : null; });
await p.mouse.move(100, 650);
await p.mouse.down();
out.stickHeld = await p.evaluate(() => document.querySelector(".joy")?.className);
await p.mouse.move(106, 652);
const dead = await want();
await p.mouse.move(160, 655);
const right = await want();
await p.mouse.move(150, 610); // diagonal-ish: stays right (no flicker)
const diag = await want();
await p.mouse.move(105, 590);
const up = await want();
await p.mouse.up();
const released = await want();
out.stick = { dead, right, diagonalKeeps: diag, up, released, expect: "-1 0 0 3 -1" };
await p.mouse.move(330, 650);
await p.mouse.down();
out.rightSideIgnored = await want();
await p.mouse.up();

await p.keyboard.down("ArrowUp");
const k1 = await want();
await p.keyboard.down("ArrowLeft");
const k2 = await want();
await p.keyboard.up("ArrowLeft");
const k3 = await want();
await p.keyboard.up("ArrowUp");
const k4 = await want();
out.keys = { up: k1, upLeft: k2, releaseLeft: k3, releaseAll: k4, expect: "3 2 3 -1" };

// (4) row y=1 of stage 3: "#P...#...o#", a branch goes down at x=4; wall at x=5
out.noTurn = await p.evaluate(async () => {
  const g = window.game.g;
  g.paused = false;
  g.p = { tx: 1, ty: 1, dir: 0, t: 0 };
  g.input.want = -1;
  await new Promise((r) => setTimeout(r, 1500));
  return { at: [g.p.tx, g.p.ty], dir: g.p.dir, expect: "stops at [4,1] (wall), never goes down the branch" };
});
console.log(JSON.stringify(out, null, 1));
console.log("errors:", errs.length ? errs : "none");
await b.close();
