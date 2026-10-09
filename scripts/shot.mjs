// Pictures for people (not for checks): node scripts/shot.mjs [url] -> .shots/
import { chromium } from "file:///Z:/Claude/_tools/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
mkdirSync(".shots", { recursive: true });
const url = process.argv[2] || "http://localhost:3395";
const b = await chromium.launch({ args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
for (const [name, vp] of [["pc", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]]) {
  const p = await b.newPage({ viewport: vp });
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(url + "/#seed=7&play&tier=3");
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `.shots/${name}-start.png` });
  // half eaten by the bot, then a burst
  await p.evaluate(() => {
    const G = window.game, g = G.g;
    window.__hold = true; window.__bot = true;
    g.lives = 99;
    while (g.pelletsLeft > g.pelletsTotal * 0.45) G.step(30);
    window.__bot = false; window.__hold = false;
    g.input.want = -1;
  });
  await p.waitForTimeout(400);
  await p.screenshot({ path: `.shots/${name}-half.png` });
  await p.evaluate(() => { const g = window.game.g; g.charge = 30; g.input.burst = true; });
  await p.waitForTimeout(250);
  await p.screenshot({ path: `.shots/${name}-burst.png` });
  console.log(name, JSON.stringify(await p.evaluate(() => window.game.stats().pellets)), errs);
  await p.close();
}
await b.close();
