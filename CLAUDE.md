@AGENTS.md

# tomoshibi-meiro — ともしび めいろ

パックマン風の迷路。光の計算は2D Radiance Cascades(RC、`Z:\Claude\tomoshibi-yoko` から流用)。**エサが光源**で、食べるほど迷路が暗くなる。おばけはRCで計算した明るさをGPUから読み戻して動く。面白さの設計は `design/fun.md`、数値は全部 `lib/tuning.ts`(ロジックに直書きしない)。

## 要件(M0 アルファ)
- 迷路はseedから自動生成(左右対称・行き止まりなし・中央におばけの巣と扉)。広さはステージごと(`STAGE_CELLS`: 1=15×17・2=19×21・3〜=19×23タイル)、画面に全体が収まる見下ろし
- エサ=光源。全部食べたらステージクリア→次のステージ(おばけ+1・速く)。四隅の大きな光の玉=食べるとともしびが満タン
- 食べたエサの光は「ともしび」にたまる(上限=つまみ chargeMax)。上限の1/6(`burstMin()`)以上で好きな時に放つ=閃光+残り火。強さは charge/CHARGE_REF なので器が大きいほど満タンが強い
- ⚙「あそびの調整」= `KNOBS`(tuning.ts)を3段で実機切替: ためる器・光の足どめ・吹き消す時間・おばけの見え方。`g.knobs` に入り、settings(localStorage)に保存。既定は `KNOB_DEFAULT`
- おばけ(2026-10-09改): エサの光(GHOST_FEAR以上)の中は遅い(GHOST_LIGHT_SLOW)。行き先のエサは GHOST_BLOW_SEC ためらって**吹き消す**(pellet=3 の暗い粒になり、食べないとクリアできないが光はたまらない)。つよい光(GHOST_WALL以上=閃光・残り火・大きな玉)には入らず、途中で出たら引き返し、中にいたら逃げる。GHOST_BURN〜GHOST_BURN_FULLで焼けて目だけになり巣へ戻る。つよい光の中のおばけは体当たりしない(焼けかけ)。つよい光以外を通る最短路(`distRoad`)でプレイヤーを追う。迷路が暗くなるほど速い(GHOST_SPEED_DARK)。旧「明るい所に一切入れない」はエサを残すと巣に閉じ込められたので却下
- 食べながらはプレイヤーが少し遅い(PLAYER_EAT_SLOW、パックマンと同じ)
- 操作: PC=矢印/WASD・Space/Enterではなつ・Escで一時停止 / スマホ=スワイプで向き・タップか✨ではなつ
- ハイスコアを localStorage(`tomoshibi-meiro-best-v1`)+hub に保存。未ログインで完全動作、🏠はhubトークンがある時だけ

## 構成
- `lib/rc.ts` — RCレンダラ(yokoからコピー)。変更は1点: 読み戻しの点数を `PROBE_N=512` に(迷路の全タイル+おばけを毎フレーム読むため)。見下ろしなので `Frame.side` は使わない
- `lib/game.ts` — 迷路生成(`buildMaze`)・グリッド移動(`advance`=タイル中心で`decide`)・エサ・ともしび/閃光(`burst()`)・おばけ(`ghostDecide`)・描画バッチ。光の読み戻しは**全タイル中心**→`tileLum`、おばけ自身の位置→`ghost.lum`。`distRoad`=プレイヤーからつよい光以外を通るBFS(毎update)
- `scripts/check-burst.mjs` — 実プレイと同じ非同期読み戻しで、1〜5マス後ろから追ってくるおばけに満タンを撃つ: 焼けたか・撃った側が死んだか
- `scripts/check-knobs.mjs` — つまみが名前どおり効くか(足どめ・吹き消す時間ごとの光る通路での速さ、器ごとの閃光の届く距離)
- `lib/bot.ts` — 検証用ボット(近いエサへ・おばけ2歩以内を避ける・近づいたら放つ)。面白さの採点には使わない
- `lib/perf.ts` — 画質の自動設定(コピー・無改造)。`lib/hub-client.ts` — APP_ID=tomoshibi-meiro
- `app/page.tsx` — ループ(`tick`)・入力・DOMのHUD(スコア・ともしびバー・残り)・⚙(画質+診断)・📷

## Build, Test & Verify
- `npm run build` / `npm run lint`(コミット前にgreen)。検証サーバーは `npx next start -p 3395` を1本だけ。**再buildの前にサーバーを止める**
- 数値の検証: `node scripts/check.mjs [url] [局数=30]` — (a) 4つ続くエサを実際に食べて、そのタイルのlightAt前後比 (b) b1: 何も食べずに待つと、おばけが火を吹き消して何秒で捕まえに来るか(=閉じ込められない)・つよい光の上に立った回数・閃光なしで焼けた回数 b2: 隣で満タンを放つと焼ける b3: 真っ暗で10〜14歩先のおばけが追いついて捕まえる (c) tier=3でエサ全部(162灯)⇔0灯を交互3回のGPU時間 (d) ボットをステージ1で30局・ステージ3(4匹)で10局(早送り)
- 2026-10-09 実測(RTX2070・tier3=高、吹き消すルール後): (a) 食べたタイル 2.6〜2.8 → 合計比0.08 (b) b1 待っているだけで3.0秒で巣を出て7.8秒で捕まる(吹き消し1個)・つよい光の上0回・閃光なしで焼けた0回 b2 0.25秒で焼けた b3 14歩→5秒で捕まった (c) 162灯⇔0灯で同じ回のGPU時間に差なし(3.1〜3.3ms) (d) ステージ1 クリア率83%・死亡1.0回/局・焼いたおばけ1.8匹/局 / ステージ3 クリア率10%・死亡2.9回/局。満タン閃光は3タイル先まで焼ける(4タイル先は3.1で焼けない)。うすあかりで遅くなる効果は数値で未確認(b1が短すぎて通らなかった)
- 光の目安(tier3): エサのタイル≈2.7 / エサ1つ隣≈0.25 / 2つに挟まれ≈0.5 / 大玉≈7〜11 / 満タン閃光(BURST_E 220・器30) 1・2・3・4タイル先 ≈47・12.7・5.7・3.1。GHOST_FEAR=0.2(光るエサが1つ隣にあればうすあかり。0.4だと吹き消した後はずっと暗がり扱いで足どめが効かなかった=一敗)・GHOST_WALL=4・GHOST_BURN=1.5
- 2026-10-09 つまみ実測(check-knobs): 光る通路の速さ 足どめ0.7/0.45/0.2 → 1.13/0.88/0.62タイル/秒、吹き消す0.25/0.5/1秒 → 1.3/0.88/0.6(暗がり4.6)。満タン閃光が焼く距離 器15/30/60 → 3/3/5タイル。全体check: 待つだけで12.7秒で捕まる・ボット ステージ1 83%/ステージ3 10%
- 2026-10-10 実測(焼け方・速さ・広さを直した後): 満タン溜め撃ちが焼く距離 直線5マス(器15/30/60 → 4/5/7)・0.2〜0.35秒・撃った側の死亡0。待つだけで11.4秒で捕まる。ボット ステージ1(15×17・エサ75) クリア率100%・平均27秒・死亡0.2回 / ステージ3 40%・死亡2.1回・焼いた2.6匹
- Gameのメソッドをアロー関数のクラスフィールドにしない: `newGame`/`retry` は `Object.assign(old, new)` で中身を移すので、アロー関数の`this`は新しい方に残る。迷路の配列をステージごとに作り直すようにしたら、プレイヤーだけ古い迷路を見て動けなくなった(一敗、playerDecide)
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
