// All the knobs. Units are in comments; logic never hard-codes these.
export const T = {
  TILE: 24, // world px
  CELLS_W: 9, // maze cells across (tiles = 2*cells+1)
  CELLS_H: 11,
  LOOP_CHANCE: 0.12, // extra wall removals after braiding (more loops = more escape routes)
  VIEW_PAD: 1.2, // tiles of margin around the maze on screen

  RC_BASE_INTERVAL: 2, // RC px, cascade0 ray length
  BOUNCE: 0.5, // wall bounce strength (0..1)
  FOG: 0.012, // light absorption per world px (display and ghosts use the same)
  EXPOSURE: 1.6,
  TONE_TOE: 0.08,
  AMBIENT: 0.02, // floor stays faintly visible in the dark
  OUTLINE_A: 0.35, // display-only blue outline of the walls (not a light: the dark stays dark)

  // pellets = the lights of the maze
  PELLET_R: 2.2, // world px
  PELLET_E: 9, // emission
  POWER_R: 5,
  POWER_E: 16,
  SCORE_PELLET: 10,
  SCORE_POWER: 50,
  SCORE_GHOST: 200, // doubled for each further ghost burned by the same burst

  // player
  PLAYER_SPEED: 5.2, // tiles/s
  PLAYER_EAT_SLOW: 0.85, // speed multiplier while the tile ahead still has a pellet (ghosts gain on you while you eat)
  LIVES: 3,
  HIT_DIST: 0.6, // tiles, ghost touch

  // charge: eaten light is stored, then released as a burst
  CHARGE_PER_PELLET: 1,
  CHARGE_PER_POWER: 30, // a power pellet fills it
  CHARGE_PER_DARK: 0, // a pellet a ghost blew out: still has to be eaten, gives no light
  // CHARGE_MAX / BURST_MIN / GHOST_LIGHT_SLOW / GHOST_BLOW_SEC live in KNOBS below (switchable in ⚙)
  CHARGE_REF: 30, // burst strength k = charge / CHARGE_REF: a bigger container (chargeMax) gives a bigger full burst
  BURST_E: 220, // emission at full charge (scales as (charge/max)^BURST_GAMMA)
  BURST_E_MIN: 25,
  BURST_GAMMA: 1.3,
  BURST_R: 9, // world px emitter radius at full charge
  BURST_SEC: 0.9, // flash duration (full brightness for the first half)
  EMBER_SEC: 6, // the spot keeps glowing (fading) this long
  EMBER_E: 14, // at full charge

  // ghosts
  GHOSTS_BASE: 2, // stage 1; +1 per stage up to GHOSTS_MAX
  GHOSTS_MAX: 4,
  GHOST_SPEED: 4.2, // tiles/s while the maze is still full of light
  GHOST_SPEED_DARK: 1.6, // + this * (fraction of pellets eaten): the darker the maze, the faster (ends above PLAYER_SPEED)
  GHOST_SPEED_PER_STAGE: 0.25,
  GHOST_SPEED_MAX: 6.4,
  GHOST_EYES_SPEED: 9,
  GHOST_RELEASE_SEC: 3, // between leaving the pen
  GHOST_RESPAWN_SEC: 5, // after being burned, wait in the pen
  // light levels (tier3): pellet tile ~2.7, 1 pellet next door ~0.25, 2 ~0.5, power pellet ~7-11
  GHOST_FEAR: 0.2, // dim light above this: ghosts walk slowly (knob lightSlow). One lit pellet next door (~0.25) counts; plain dark is mostly < 0.15
  GHOST_WALL: 4, // strong light (burst, ember, power pellet) above this: ghosts will not enter, and flee if caught in it
  GHOST_BURN: 1.5, // light where ghosts start to burn (full at 3x). Ghosts never stand on a lit pellet (they blow it out first), so pellets stay below this
  GHOST_BURN_DPS: 5, // hp/s at full burn (hp = 1)
  GHOST_SLOW_IN_LIGHT: 0.5, // speed multiplier while burning
  GHOST_WANDER: 0.15, // chance to take a random dark turn instead of the shortest dark path

  HITSTOP: 0.05,
  DEATH_SEC: 1.2,
  CLEAR_SEC: 1.6,
};

// knobs to compare on the device: ⚙ あそびの調整, 3 steps each (index 1 = the current value)
export type KnobKey = "chargeMax" | "lightSlow" | "blowSec" | "see";
export const KNOBS: { key: KnobKey; name: string; title: string; vals: number[]; labels: string[] }[] = [
  { key: "chargeMax", name: "ためる器", title: "ともしびの上限。大きいほど満タンの閃光が強く遠くまで届く(放てるのは上限の1/6から)", vals: [15, 30, 60], labels: ["小さく", "今", "大きく"] },
  { key: "lightSlow", name: "光の足どめ", title: "エサの光の中でおばけが遅くなる度合い(速さの倍率)", vals: [0.7, 0.45, 0.2], labels: ["弱く", "今", "強く"] },
  { key: "blowSec", name: "吹き消す時間", title: "おばけがエサの火を消すまでためらう秒数", vals: [0.25, 0.5, 1], labels: ["短く", "今", "長く"] },
  { key: "see", name: "おばけの見え方", title: "暗がりでのおばけの見えやすさ", vals: [0, 1, 2], labels: ["目だけ", "うっすら", "はっきり"] },
];
export const KNOB_DEFAULT = [1, 1, 1, 0];
