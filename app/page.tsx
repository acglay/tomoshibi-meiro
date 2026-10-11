"use client";

import { useEffect, useRef, useState } from "react";
import { Game, Mode } from "@/lib/game";
import { PUZZLES } from "@/lib/puzzles";
import { botStep } from "@/lib/bot";
import { RC } from "@/lib/rc";
import { T, KNOBS, KNOB_DEFAULT } from "@/lib/tuning";
import { AutoPerf, TIERS, guessTier, isMobile } from "@/lib/perf";
import { captureHubToken, hubToken, hubLoad, hubSave, HUB_URL } from "@/lib/hub-client";

const BEST_KEY = "tomoshibi-meiro-best-v1";
const SET_KEY = "tomoshibi-meiro-settings-v1";
const PERF_KEY = "tomoshibi-meiro-perf-v1";
const PUZZLE_KEY = "tomoshibi-meiro-puzzle-v1"; // highest puzzle stage cleared
const DEF = { perf: -1, knobs: KNOB_DEFAULT }; // perf: -1 = auto, 0..4 = fixed tier. knobs: index into KNOBS[i].vals
const HUD_CSS = 54; // css px kept free above the maze
const STICK_R = 50; // css px: knob travel
const STICK_DEAD = 8; // css px: no direction inside this
const TURN_GRACE_MS = 200; // a direction stays wanted this long after letting go (quick flicks still turn)
const STICK_AREA = 0.6; // a press left of this fraction of the screen width grabs the stick

type Toast = { id: number; text: string; color: string };
type Dbg = { __hold?: boolean; __bot?: boolean; __botOpts?: Parameters<typeof botStep>[1] };

export default function Page() {
  const glRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const [settings, setSettings] = useState({ ...DEF });
  const [panel, setPanel] = useState(false);
  const [started, setStarted] = useState(false);
  const [over, setOver] = useState<null | { score: number; stage: number; allClear: boolean }>(null);
  const [mode, setMode] = useState<Mode>("chase");
  const [stick, setStick] = useState<null | { x: number; y: number; dx: number; dy: number }>(null);
  const [cleared, setCleared] = useState(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
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
    const pz = Number(localStorage.getItem(PUZZLE_KEY) || 0);
    setCleared(pz);
    hubLoad("puzzle").then((r) => {
      const v = Number(r?.value || 0);
      if (v > pz) {
        localStorage.setItem(PUZZLE_KEY, String(v));
        setCleared(v);
      }
    });
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
    const hashMode: Mode = hash.get("mode") === "puzzle" ? "puzzle" : "chase";
    const g = new Game(seed, hashMode);
    gameRef.current = g;
    hookUp(g);
    if (hashMode === "puzzle") {
      g.newStage(Math.max(1, Math.min(PUZZLES.length, Number(hash.get("stage")) || 1)));
      setMode("puzzle");
    }
    if (hash.has("play")) setStarted(true);
    applyTier(manual >= 0 ? manual : auto.tier);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const KEYS: Record<string, number> = { ArrowRight: 0, KeyD: 0, ArrowDown: 1, KeyS: 1, ArrowLeft: 2, KeyA: 2, ArrowUp: 3, KeyW: 3 };
    // a turn is wanted only while a key / the stick is held: let go and the player keeps going straight
    // (a remembered swipe used to turn at the next corner by itself)
    const held: number[] = [];
    const kd = (e: KeyboardEvent) => {
      if (e.code in KEYS) {
        e.preventDefault();
        const d = KEYS[e.code];
        if (!held.includes(d)) held.push(d);
        g.input.want = d;
      }
      if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); if (!e.repeat) g.input.burst = true; }
      if (e.code === "Escape") g.paused = !g.paused;
    };
    const ku = (e: KeyboardEvent) => {
      if (!(e.code in KEYS)) return;
      const i = held.indexOf(KEYS[e.code]);
      if (i >= 0) held.splice(i, 1);
      if (held.length) g.input.want = held[held.length - 1];
      else letGo();
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);

    // stick: press anywhere on the left part of the screen, that point is the stick's center while held
    let st: { id: number; x: number; y: number } | null = null;
    const pick = (dx: number, dy: number) => {
      if (Math.hypot(dx, dy) < STICK_DEAD) return -1;
      const h = dx > 0 ? 0 : 2;
      const v = dy > 0 ? 1 : 3;
      // a diagonal push: the axis the player is not already moving along wins (= the turn you are asking for)
      const moving = g.p.dir;
      if (Math.min(Math.abs(dx), Math.abs(dy)) > STICK_DEAD * 1.5) {
        if (moving === h) return v;
        if (moving === v) return h;
      }
      return Math.abs(dx) > Math.abs(dy) ? h : v;
    };
    let graceT = 0;
    const letGo = () => {
      const w = g.input.want;
      clearTimeout(graceT);
      graceT = window.setTimeout(() => { if (!st && !held.length && g.input.want === w) g.input.want = -1; }, TURN_GRACE_MS);
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") setTouch(true);
      if (st || e.clientX > window.innerWidth * STICK_AREA) return;
      st = { id: e.pointerId, x: e.clientX, y: e.clientY };
      setStick({ x: st.x, y: st.y, dx: 0, dy: 0 });
    };
    const onMove = (e: PointerEvent) => {
      if (!st || e.pointerId !== st.id) return;
      let dx = e.clientX - st.x;
      let dy = e.clientY - st.y;
      const l = Math.hypot(dx, dy);
      if (l > STICK_R) { dx = (dx / l) * STICK_R; dy = (dy / l) * STICK_R; }
      g.input.want = pick(dx, dy);
      setStick({ x: st.x, y: st.y, dx, dy });
    };
    const onUp = (e: PointerEvent) => {
      if (!st || e.pointerId !== st.id) return;
      st = null;
      letGo();
      setStick(null);
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
      if (dbg.__bot) botStep(g, dbg.__botOpts);
      const c0 = performance.now();
      g.update(dt);
      if (g.over && !wasOver) {
        wasOver = true;
        setOver({ score: g.score, stage: g.stage, allClear: g.allClear });
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
      newGame: (s: number, m: Mode = "chase", stage = 1) => {
        const ng = new Game(s, m);
        ng.input = g.input;
        ng.knobs = g.knobs;
        Object.assign(g, ng);
        if (stage > 1) g.newStage(stage);
        applyKnobs(g, settingsRef.current.knobs);
      },
    };

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // mount once: hookUp only wires toast/setCleared, which never change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem(SET_KEY, JSON.stringify(settings));
    applyTierRef.current?.(settings.perf);
    if (gameRef.current) applyKnobs(gameRef.current, settings.knobs);
  }, [settings]);

  useEffect(() => {
    if (gameRef.current) gameRef.current.paused = !started;
  }, [started]);

  // toasts and progress saving for whatever game is running
  function hookUp(g: Game) {
    g.onToast = (t, c) => toast(t, c);
    g.onStage = (s) => {
      if (g.mode === "puzzle") {
        const p = PUZZLES[s - 1];
        toast(`🧩 ${s}. ${p.name}`, "#ffd890");
        toast(p.hint, "#bfe6ff");
      } else if (s > 1) toast(`ステージ ${s}`, "#ffd890");
    };
    g.onClear = (s) => {
      if (g.mode !== "puzzle") return;
      const was = Number(localStorage.getItem(PUZZLE_KEY) || 0);
      if (s > was) {
        localStorage.setItem(PUZZLE_KEY, String(s));
        setCleared(s);
        hubSave("puzzle", s);
      }
    };
  }

  const start = (m: Mode, stage = 1) => {
    const old = gameRef.current!;
    const g = new Game(Math.floor(Math.random() * 1e9), m);
    g.input = old.input;
    g.knobs = old.knobs;
    Object.assign(old, g);
    hookUp(old);
    if (m === "puzzle") old.newStage(stage);
    else old.onStage(1);
    applyKnobs(old, settings.knobs);
    setMode(m);
    setOver(null);
    setStarted(true);
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
        {started && mode === "puzzle" && !over && <button className="rb" title="この面をやりなおす" onClick={() => gameRef.current?.newStage(gameRef.current.stage)}>↺</button>}
        {started && <button className="rb" title="メニュー" onClick={() => { setStarted(false); setOver(null); }}>☰</button>}
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
        <div className={stick ? "joy held" : "joy"} style={stick ? { left: stick.x - 55, top: stick.y - 55 } : { left: 24, bottom: 36 }}>
          <div className="knob" style={stick ? { transform: `translate(${stick.dx}px, ${stick.dy}px)` } : undefined} />
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
          <p className="keys">PC: 矢印キー/WASD を おしている あいだ その向きへ曲がる ・ Space ではなつ<br />スマホ: 左の スティックを たおしている あいだ その向きへ曲がる(はなすと まっすぐ) ・ ✨ ではなつ</p>
          <div className="modes">
            <div className="mode">
              <button className="go" onClick={() => start("puzzle", Math.min(PUZZLES.length, cleared + 1))}>🧩 パズル</button>
              <div className="stages">
                {PUZZLES.map((p, i) => (
                  <button key={p.name} className={i < cleared ? "done" : ""} disabled={i > cleared} title={p.name} onClick={() => start("puzzle", i + 1)}>{i + 1}</button>
                ))}
              </div>
            </div>
            <div className="mode">
              <button className="go" onClick={() => start("chase")}>👻 おいかけっこ</button>
              {best > 0 && <p className="best">ハイスコア {best}</p>}
            </div>
          </div>
        </div>
      )}
      {over && !over.allClear && (
        <div className="overlay">
          <h1>くらやみに のまれた…</h1>
          <p className="sub">スコア {over.score} / ステージ {over.stage}</p>
          {best > 0 && <p className="best">ハイスコア {best}</p>}
          <button className="go" onClick={() => start("chase")}>もう一度</button>
        </div>
      )}
      {over && over.allClear && (
        <div className="overlay">
          <h1>ぜんぶ クリア!</h1>
          <p className="sub">🧩 {PUZZLES.length} めん ぜんぶ ときました</p>
          <button className="go" onClick={() => { setStarted(false); setOver(null); }}>メニューへ</button>
        </div>
      )}
      {err && <div className="overlay"><h1>うごきません</h1><p>{err}</p></div>}
    </main>
  );
}

// DOM HUD, touched only when a value changes
const hudSeen = { key: "" };
// puzzles are designed for the default values: there only "how ghosts look" follows the ⚙ knobs
function applyKnobs(g: Game, idx: number[] | undefined) {
  KNOBS.forEach((k, i) => { g.knobs[k.key] = k.vals[g.mode === "puzzle" && k.key !== "see" ? KNOB_DEFAULT[i] : idx?.[i] ?? KNOB_DEFAULT[i]]; });
  hudSeen.key = "";
}
function drawHud(el: HTMLDivElement, g: Game) {
  const key = `${g.mode}/${g.score}/${g.charge}/${g.stage}/${g.lives}/${g.pelletsLeft}/${g.knobs.chargeMax}`;
  if (key === hudSeen.key) return;
  hudSeen.key = key;
  (el.children[0] as HTMLElement).textContent = g.mode === "puzzle" ? `🧩 ${g.stage}/${PUZZLES.length}` : String(g.score);
  const bar = el.children[1] as HTMLElement;
  const fill = bar.children[0] as HTMLElement;
  fill.style.width = `${(100 * g.charge) / g.knobs.chargeMax}%`;
  fill.className = g.charge >= g.burstMin() ? "ready" : "";
  (bar.children[1] as HTMLElement).style.left = `${(100 * g.burstMin()) / g.knobs.chargeMax}%`;
  (el.children[2] as HTMLElement).textContent = g.mode === "puzzle" ? `${g.puzzle().name}   のこり ${g.pelletsLeft}` : `ステージ ${g.stage}   ${"●".repeat(Math.max(0, Math.min(9, g.lives)))}   のこり ${g.pelletsLeft}`;
}
