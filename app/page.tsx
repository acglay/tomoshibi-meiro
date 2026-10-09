"use client";

import { useEffect, useRef, useState } from "react";
import { Game } from "@/lib/game";
import { botStep } from "@/lib/bot";
import { RC } from "@/lib/rc";
import { T, KNOBS, KNOB_DEFAULT } from "@/lib/tuning";
import { AutoPerf, TIERS, guessTier, isMobile } from "@/lib/perf";
import { captureHubToken, hubToken, hubLoad, hubSave, HUB_URL } from "@/lib/hub-client";

const BEST_KEY = "tomoshibi-meiro-best-v1";
const SET_KEY = "tomoshibi-meiro-settings-v1";
const PERF_KEY = "tomoshibi-meiro-perf-v1";
const DEF = { perf: -1, knobs: KNOB_DEFAULT }; // perf: -1 = auto, 0..4 = fixed tier. knobs: index into KNOBS[i].vals
const HUD_CSS = 54; // css px kept free above the maze

type Toast = { id: number; text: string; color: string };
type Dbg = { __hold?: boolean; __bot?: boolean };

export default function Page() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [settings, setSettings] = useState({ ...DEF });
  const [panel, setPanel] = useState(false);
  const [started, setStarted] = useState(false);
  const [over, setOver] = useState<null | { score: number; stage: number }>(null);
  const [err, setErr] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [hub, setHub] = useState(false);
  const [best, setBest] = useState(0);
  const [touch, setTouch] = useState(false);
  const shotRef = useRef(false);
  const applyTierRef = useRef<((p: number) => void) | null>(null);
  const [tierView, setTierView] = useState<{ tier: number; gpu: number; diag?: string }>({ tier: 3, gpu: -1 });

  const toast = (text: string, color = "#eee") => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, color }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  };

  useEffect(() => {
    captureHubToken();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHub(!!hubToken());
    setTouch(matchMedia("(pointer: coarse)").matches);
    let savedPerf = -1;
    try {
      const s = JSON.parse(localStorage.getItem(SET_KEY) || "null");
      if (s) { setSettings((o) => ({ ...o, ...s })); savedPerf = Number(s.perf ?? -1); }
    } catch {}
    const b = Number(localStorage.getItem(BEST_KEY) || 0);
    setBest(b);
    hubLoad("best").then((r) => {
      const v = Number(r?.value || 0);
      if (v > b) {
        localStorage.setItem(BEST_KEY, String(v));
        setBest(v);
      }
    });

    const hash = new URLSearchParams(location.hash.slice(1));
    const seed = Number(hash.get("seed")) || Math.floor(Math.random() * 1e9);
    const canvas = glRef.current!;
    const hud = hudRef.current!;
    let rc: RC;
    try {
      rc = new RC(canvas, !isMobile(""));
      rc.finishEachFrame = isMobile(rc.renderer);
      if (!rc.ok) setErr(rc.err);
    } catch (e) {
      setErr(String(e));
      return;
    }
    let saved: { renderer?: string; tier?: number } = {};
    try { saved = JSON.parse(localStorage.getItem(PERF_KEY) || "{}"); } catch {}
    const forced = hash.has("tier") ? Number(hash.get("tier")) : -1;
    const start = saved.renderer === rc.renderer && saved.tier !== undefined ? saved.tier : guessTier(rc.renderer);
    const auto = new AutoPerf(start, rc.hasTimer);
    let dprCap = 2;
    let manual = forced >= 0 ? forced : savedPerf;
    let curTier = -1;
    let cw = 0;
    let ch = 0;
    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      cw = Math.round(canvas.clientWidth * dpr);
      ch = Math.round(canvas.clientHeight * dpr);
      canvas.width = cw;
      canvas.height = ch;
    };
    const applyTier = (t: number) => {
      t = Math.max(0, Math.min(TIERS.length - 1, t));
      if (t === curTier) return;
      curTier = t;
      rc.rcScale = TIERS[t].rc;
      rc.bilinearFix = TIERS[t].fix;
      dprCap = TIERS[t].dpr;
      resize();
    };
    applyTierRef.current = (p: number) => {
      manual = forced >= 0 ? forced : p;
      applyTier(manual >= 0 ? manual : auto.tier);
    };
    rc.baseInterval = T.RC_BASE_INTERVAL;
    const g = new Game(seed);
    gameRef.current = g;
    g.onToast = (t, c) => toast(t, c);
    g.onStage = (s) => { if (s > 1) toast(`ステージ ${s}`, "#ffd890"); };
    if (hash.has("play")) setStarted(true);
    applyTier(manual >= 0 ? manual : auto.tier);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const KEYS: Record<string, number> = { ArrowRight: 0, KeyD: 0, ArrowDown: 1, KeyS: 1, ArrowLeft: 2, KeyA: 2, ArrowUp: 3, KeyW: 3 };
    const kd = (e: KeyboardEvent) => {
      if (e.code in KEYS) { e.preventDefault(); g.input.want = KEYS[e.code]; }
      if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); if (!e.repeat) g.input.burst = true; }
      if (e.code === "Escape") g.paused = !g.paused;
    };
    window.addEventListener("keydown", kd);

    // swipe anywhere = turn (re-armed every 18px so a long drag can turn twice), a short tap = release
    let sw: { id: number; x: number; y: number; x0: number; y0: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") setTouch(true);
      sw = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now() };
    };
    const onMove = (e: PointerEvent) => {
      if (!sw || e.pointerId !== sw.id) return;
      const dx = e.clientX - sw.x;
      const dy = e.clientY - sw.y;
      if (Math.hypot(dx, dy) < 18) return;
      g.input.want = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : 2) : dy > 0 ? 1 : 3;
      sw.x = e.clientX;
      sw.y = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (!sw || e.pointerId !== sw.id) return;
      if (Math.hypot(e.clientX - sw.x0, e.clientY - sw.y0) < 12 && performance.now() - sw.t < 300) g.input.burst = true;
      sw = null;
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    const noCtx = (e: Event) => e.preventDefault();
    canvas.addEventListener("contextmenu", noCtx);

    let last = performance.now();
    let fps = 60;
    let raf = 0;
    let wasOver = false;
    const diag = { cpu: -1, submit: -1, hud: -1 };
    // one full tick: game -> RC -> light read back (used by the rAF loop and by check.mjs's fast-forward)
    const tick = (dt: number, syncProbe = false) => {
      const dbg = window as unknown as Dbg;
      if (dbg.__bot) botStep(g);
      const c0 = performance.now();
      g.update(dt);
      if (g.over && !wasOver) {
        wasOver = true;
        setOver({ score: g.score, stage: g.stage });
        const b = Number(localStorage.getItem(BEST_KEY) || 0);
        if (g.score > b) {
          localStorage.setItem(BEST_KEY, String(g.score));
          setBest(g.score);
          hubSave("best", g.score);
        }
      }
      if (!g.over) wasOver = false;
      const hudPx = HUD_CSS * dpr;
      const wpp = g.fit(cw, ch, hudPx);
      const f = g.frame(cw, ch, wpp, hudPx);
      rc.serial = g.probeSerial;
      const prevSerial = rc.lumSerial;
      const c1 = performance.now();
      rc.render(f);
      const c2 = performance.now();
      if (syncProbe) {
        // inside one JS task WebGL fences never signal, so the fast-forward reads the probes synchronously
        const pts: number[][] = [];
        for (let i = 0; i < f.probeCount; i++) pts.push([f.probes[i * 2], f.probes[i * 2 + 1]]);
        g.applyLum(g.probeSerial, Float32Array.from(rc.measureSync(pts, "game")), pts.length);
      } else if (rc.lumSerial !== prevSerial) g.applyLum(rc.lumSerial, rc.lum, rc.lumReady);
      return { c0, c1, c2, f, wpp };
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if ((window as unknown as Dbg).__hold) return;
      fps = fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
      if (manual < 0) {
        const was = auto.phase;
        const nt = auto.tick(dt * 1000, rc.gpuMs, rc.gpuSerial, !g.paused && !g.over && document.visibilityState === "visible");
        if (nt !== null) {
          applyTier(nt);
          if (was === "run") toast(`重かったので画質を「${TIERS[nt].name}」に下げました`, "#9fb");
        }
        if ((was === "calib" && auto.phase === "run") || (nt !== null && was === "run")) localStorage.setItem(PERF_KEY, JSON.stringify({ renderer: rc.renderer, tier: auto.tier }));
      }
      if (Math.floor(now / 500) !== Math.floor((now - dt * 1000) / 500))
        setTierView({ tier: curTier, gpu: rc.gpuMs, diag: `${Math.round(fps)}fps ・ 計算${diag.cpu.toFixed(1)} 描画${diag.submit.toFixed(1)}${rc.finishEachFrame ? "(待ち込)" : ""} HUD${diag.hud.toFixed(1)}ms ・ ${cw}×${ch} RC${rc.W}×${rc.H} ・ ${rc.renderer.replace(/^ANGLE \(|\)$/g, "").slice(0, 60)}` });
      const { c0, c1, c2 } = tick(dt);
      drawHud(hud, g);
      const c3 = performance.now();
      const ema = (a: number, b: number) => (a < 0 ? b : a * 0.93 + b * 0.07);
      diag.cpu = ema(diag.cpu, c1 - c0);
      diag.submit = ema(diag.submit, c2 - c1);
      diag.hud = ema(diag.hud, c3 - c2);
      if (shotRef.current) {
        shotRef.current = false;
        const c = document.createElement("canvas");
        c.width = canvas.width;
        c.height = canvas.height;
        c.getContext("2d")!.drawImage(canvas, 0, 0);
        const a = document.createElement("a");
        a.href = c.toDataURL("image/png");
        a.download = `tomoshibi-meiro-${g.seed}-s${g.stage}.png`;
        a.click();
      }
    };
    raf = requestAnimationFrame(loop);

    (window as unknown as { game: unknown }).game = {
      g,
      rc,
      stats: () => ({
        fps: Math.round(fps),
        lights: g.lightCount,
        pellets: g.pelletsLeft,
        pelletsTotal: g.pelletsTotal,
        charge: g.charge,
        score: g.score,
        stage: g.stage,
        lives: g.lives,
        ghosts: g.ghosts.map((e) => e.state),
        maze: [g.W, g.H],
        rc: { W: rc.W, H: rc.H, cascades: rc.cascades, scale: rc.rcScale, fix: rc.bilinearFix },
        diag: { ...diag },
        perf: { tier: curTier, name: TIERS[curTier]?.name, auto: manual < 0, phase: auto.phase, gpuMs: Math.round(rc.gpuMs * 100) / 100, gpuSerial: rc.gpuSerial, hasTimer: rc.hasTimer, renderer: rc.renderer, canvas: [cw, ch] },
      }),
      lightAt: (pts: number[][], which: "view" | "game" = "view") => rc.measureSync(pts, which),
      // fast-forward n ticks synchronously (set window.__hold first so the rAF loop stays out of the way)
      step: (n: number, dt = 1 / 30) => {
        for (let i = 0; i < n && !g.over; i++) tick(dt, true);
      },
      newGame: (s: number) => {
        const ng = new Game(s);
        ng.onToast = () => {};
        ng.onStage = () => {};
        ng.input = g.input;
        ng.knobs = g.knobs;
        Object.assign(g, ng);
      },
    };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", kd);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SET_KEY, JSON.stringify(settings));
    applyTierRef.current?.(settings.perf);
    if (gameRef.current) applyKnobs(gameRef.current, settings.knobs);
  }, [settings]);

  useEffect(() => {
    if (gameRef.current) gameRef.current.paused = !started;
  }, [started]);

  const retry = () => {
    const old = gameRef.current!;
    const g = new Game(Math.floor(Math.random() * 1e9));
    g.onToast = old.onToast;
    g.onStage = old.onStage;
    g.input = old.input;
    g.knobs = old.knobs;
    Object.assign(old, g);
    setOver(null);
  };

  const release = (e: React.PointerEvent) => {
    e.stopPropagation();
    if (gameRef.current) gameRef.current.input.burst = true;
  };

  return (
    <main className="root">
      <canvas ref={glRef} className="layer" />
      <div ref={hudRef} className="hudbar">
        <div className="score" />
        <div className="charge"><i /><b /></div>
        <div className="line2" />
      </div>
      <div className="topbar">
        {hub && <a className="rb" href={HUB_URL} title="ホームへ">🏠</a>}
        <button className="rb" title="スクショ保存" onClick={() => (shotRef.current = true)}>📷</button>
        <button className="rb" title="設定" onClick={() => setPanel((p) => !p)}>⚙</button>
      </div>
      {panel && (
        <div className="panel">
          <div className="ptitle">設定</div>
          <div className="ptitle2">画質 <span className="pnow">いま: {TIERS[tierView.tier]?.name}{tierView.gpu >= 0 ? ` (GPU ${tierView.gpu.toFixed(1)}ms)` : ""}</span></div>
          <div className="views">
            <button className={settings.perf < 0 ? "on" : ""} onClick={() => setSettings((s) => ({ ...s, perf: -1 }))}>自動</button>
            {TIERS.map((t, i) => (
              <button key={t.name} className={settings.perf === i ? "on" : ""} onClick={() => setSettings((s) => ({ ...s, perf: i }))}>{t.name}</button>
            ))}
          </div>
          <div className="diag">診断: {tierView.diag}</div>
          <div className="ptitle2">あそびの調整 <span className="pnow">(すぐ効く・ためしてみて)</span></div>
          {KNOBS.map((k, ki) => (
            <div key={k.key} className="knob3" title={k.title}>
              <span className="lab">{k.name}</span>
              <div className="views">
                {k.labels.map((l, vi) => (
                  <button key={l} className={(settings.knobs?.[ki] ?? KNOB_DEFAULT[ki]) === vi ? "on" : ""} onClick={() => setSettings((s) => { const kn = [...(s.knobs ?? KNOB_DEFAULT)]; kn[ki] = vi; return { ...s, knobs: kn }; })}>{l}</button>
                ))}
              </div>
            </div>
          ))}
          <p className="note">ひかりの計算: Radiance Cascades。エサが何百あっても計算量はほぼ一定。おばけは画面と同じ光の計算結果を読んで動く。</p>
        </div>
      )}
      {touch && started && !over && (
        <div className="pad">
          <button className="sk big" onPointerDown={release}>✨ はなつ</button>
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast" style={{ color: t.color }}>{t.text}</div>
        ))}
      </div>
      {!started && !err && (
        <div className="overlay">
          <h1>ともしび めいろ</h1>
          <p className="sub">エサは あかり。たべるほど めいろは くらくなる。</p>
          <ul>
            <li>🟡 エサを ぜんぶ たべたら クリア</li>
            <li>👻 おばけは エサの光の中では おそい。<b>エサの火を ふきけしながら</b> せまってくる</li>
            <li>💥 はなった光と 大きな光の玉には はいれない。ちかくで はなつと やける</li>
            <li>✨ たべた ひかりは ともしびに たまる。ためるほど 大きく はなてる</li>
            <li>🟠 おおきな ひかりの玉は ともしびが まんたんに なる</li>
          </ul>
          <p className="keys">PC: 矢印キー/WASD で向きを変える ・ Space ではなつ<br />スマホ: スワイプで向きを変える ・ タップか ✨ ではなつ</p>
          {best > 0 && <p className="best">ハイスコア {best}</p>}
          <button className="go" onClick={() => setStarted(true)}>はじめる</button>
        </div>
      )}
      {over && (
        <div className="overlay">
          <h1>くらやみに のまれた…</h1>
          <p className="sub">スコア {over.score} / ステージ {over.stage}</p>
          {best > 0 && <p className="best">ハイスコア {best}</p>}
          <button className="go" onClick={retry}>もう一度</button>
        </div>
      )}
      {err && <div className="overlay"><h1>うごきません</h1><p>{err}</p></div>}
    </main>
  );
}

// DOM HUD, touched only when a value changes
const hudSeen = { key: "" };
function applyKnobs(g: Game, idx: number[] | undefined) {
  KNOBS.forEach((k, i) => { g.knobs[k.key] = k.vals[idx?.[i] ?? KNOB_DEFAULT[i]]; });
  hudSeen.key = "";
}
function drawHud(el: HTMLDivElement, g: Game) {
  const key = `${g.score}/${g.charge}/${g.stage}/${g.lives}/${g.pelletsLeft}/${g.knobs.chargeMax}`;
  if (key === hudSeen.key) return;
  hudSeen.key = key;
  (el.children[0] as HTMLElement).textContent = String(g.score);
  const bar = el.children[1] as HTMLElement;
  const fill = bar.children[0] as HTMLElement;
  fill.style.width = `${(100 * g.charge) / g.knobs.chargeMax}%`;
  fill.className = g.charge >= g.burstMin() ? "ready" : "";
  (bar.children[1] as HTMLElement).style.left = `${(100 * g.burstMin()) / g.knobs.chargeMax}%`;
  (el.children[2] as HTMLElement).textContent = `ステージ ${g.stage}   ${"●".repeat(Math.max(0, Math.min(9, g.lives)))}   のこり ${g.pelletsLeft}`;
}
