@AGENTS.md

# tomoshibi-meiro — ともしび めいろ

パックマン風の迷路。光の計算は2D Radiance Cascades(RC、`Z:\Claude\tomoshibi-yoko` から流用)。**エサが光源**で、食べるほど迷路が暗くなる。おばけはRCで計算した明るさをGPUから読み戻して動く。面白さの設計は `design/fun.md`、数値は全部 `lib/tuning.ts`(ロジックに直書きしない)。

## 要件(M0 アルファ)
- 迷路はseedから自動生成(左右対称・行き止まりなし・中央におばけの巣と扉)。19×23タイル、画面に全体が収まる見下ろし
- エサ=光源。全部食べたらステージクリア→次のステージ(おばけ+1・速く)。四隅の大きな光の玉=食べるとともしびが満タン
- 食べたエサの光は「ともしび」にたまる(CHARGE_*)。BURST_MIN以上で好きな時に放つ=閃光+残り火。ためるほど大きい
- おばけ: 明るいタイル(GHOST_FEAR以上)には入らない・途中で光が出たら引き返す・中にいたら暗い方へ逃げる。もっと明るいと焼けて目だけになり巣へ戻る。暗いタイルだけを通る最短路でプレイヤーを追う。迷路が暗くなるほど速くなる(GHOST_SPEED_DARK)
- 食べながらはプレイヤーが少し遅い(PLAYER_EAT_SLOW、パックマンと同じ)
- 操作: PC=矢印/WASD・Space/Enterではなつ・Escで一時停止 / スマホ=スワイプで向き・タップか✨ではなつ
- ハイスコアを localStorage(`tomoshibi-meiro-best-v1`)+hub に保存。未ログインで完全動作、🏠はhubトークンがある時だけ

## 構成
- `lib/rc.ts` — RCレンダラ(yokoからコピー)。変更は1点: 読み戻しの点数を `PROBE_N=512` に(迷路の全タイル+おばけを毎フレーム読むため)。見下ろしなので `Frame.side` は使わない
- `lib/game.ts` — 迷路生成(`buildMaze`)・グリッド移動(`advance`=タイル中心で`decide`)・エサ・ともしび/閃光(`burst()`)・おばけ(`ghostDecide`)・描画バッチ。光の読み戻しは**全タイル中心**→`tileLum`、おばけ自身の位置→`ghost.lum`。`distDark`=プレイヤーから暗いタイルだけを通るBFS(毎update)
- `lib/bot.ts` — 検証用ボット(近いエサへ・おばけ2歩以内を避ける・近づいたら放つ)。面白さの採点には使わない
- `lib/perf.ts` — 画質の自動設定(コピー・無改造)。`lib/hub-client.ts` — APP_ID=tomoshibi-meiro
- `app/page.tsx` — ループ(`tick`)・入力・DOMのHUD(スコア・ともしびバー・残り)・⚙(画質+診断)・📷

## Build, Test & Verify
- `npm run build` / `npm run lint`(コミット前にgreen)。検証サーバーは `npx next start -p 3395` を1本だけ。**再buildの前にサーバーを止める**
- 数値の検証: `node scripts/check.mjs [url] [局数=30]` — (a) 4つ続くエサを実際に食べて、そのタイルのlightAt前後比 (b) b1: 全方向が光るタイルに置いたおばけが3秒動かない b2: 隣で満タンを放つと焼ける b3: 真っ暗で10〜14歩先のおばけが追いついて捕まえる (c) tier=3でエサ全部(162灯)⇔0灯を交互3回のGPU時間 (d) ボットをステージ1で30局・ステージ3(4匹)で10局(早送り)
- 2026-10-09 実測(RTX2070・tier3=高): (a) 食べたタイル 2.6〜2.8 → 0.07〜0.5(合計比0.08) (b) b1 移動0・そのタイル0.61/隣2.6〜2.9 b2 0.25秒で焼けた(最大lum 24) b3 14歩→5秒で捕まった (c) 162灯 2.1〜2.4ms / 0灯 2.05〜2.3ms(同じ回で差なし) (d) ステージ1 クリア率97%・平均56秒・死亡0.3回/局(負けた1局は99%食べた所) / ステージ3 クリア率70%・死亡1.5回/局・負けは94%食べた所=終盤の暗がりで死ぬ
- 光の目安(tier3): エサのタイル≈2.7 / エサ1つ隣≈0.25 / 2つに挟まれ≈0.5 / 大玉≈7〜11 / 満タン閃光 1・2・3・4タイル先 ≈24・7.4・3.4・1.75。GHOST_FEAR=0.4・GHOST_BURN=0.9はこれに合わせた
- **早送り(`window.game.step(n)`)は光を同期で読む**(`measureSync`)。1つのJSタスクの中ではWebGLのfenceが絶対にsignalしない(Chromeの仕様)ので、非同期読み戻しのままだと`tileLum`が古いまま止まる(一敗)
- 回帰: `node Z:/Claude/_tools/smoke.mjs --app tomoshibi-meiro "http://localhost:3395/#seed=7&tier=3&play" --settle 3000`(baseline登録済み 2026-10-09)。HUDはDOMにした(透明canvasの重ねは「描画されてない疑い」になる)
- 見た目(人用): `node scripts/shot.mjs` → `.shots/`(PC・スマホ縦 × 開始・半分・閃光)
- 数値API: `window.game.stats()` / `lightAt([[x,y],...], "game")`(world座標)/ `g`(Game本体: `tileLum` `lumAt(x,y)` `pellet` `ghosts` `bfs()` `newStage(n)`)/ `step(n, dt)`(早送り、先に `window.__hold=true`)/ `newGame(seed)` / `window.__bot=true`でボット操作
- タイル(x,y)の中心 world = ((x+0.5)*24, (y+0.5)*24)。RC領域は迷路全体を覆う(画面に全体が入るので、どの点でも読める)
- URL: `#seed=N` `#play` `#tier=N`

## 運用
- APP_ID = tomoshibi-meiro。localStorageキーは `tomoshibi-meiro-<用途>-v1`(best・settings・perf)
- WebGLの `preserveDrawingBuffer` はPCでオン(smokeと📷のため)、スマホはオフ。スマホは毎フレーム `gl.finish()`、低い2段はバイリニア修正オフ
- 区切りごとにcommit+push。公開: https://tomoshibi-meiro.vercel.app(公開repo+GitHub連携=pushで自動デプロイ・hub登録済み 2026-10-09)。新版を出したら `hub/scripts/register-version.mjs` まで

## 未実装(M0の外)
- 効果音・BGM / コントローラー / おばけの個性(待ち伏せ型など) / ステージごとの迷路の形の変化
