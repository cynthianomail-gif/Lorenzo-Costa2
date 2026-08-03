# JP 尊位改為揭露時公布（取消抽牌）

日期：2026-08-03
狀態：已實作

## 背景

原本的宙斯／赫拉 JP 走抽牌流程：達成航海地圖第 5 步（進階合成）後，連爆全部結束時跳出全畫面抽牌介面，玩家從兩張背牌中點一張，翻牌才知道拿到哪一尊。

企劃決定取消抽牌，改成在藏寶圖「揭露下一個條件」時就公布本局 JP 歸屬，達成後於結算直接發放。

## 設計

### 尊位決定與生命週期

新增 `jpBoss`（0=宙斯 1=赫拉）與 `jpGranted`（本輪地圖是否已發放）。兩者由 `rollJpBoss()` 一併重設，呼叫點與 `questOrder` 洗牌完全同步，共 4 處：

- `resetRoundState()` 的 `if (!inSFG)` 區塊 — NG／FG 每局重置
- `endRound()` 的 SFG 結束分支
- SYNTHESIS 狀態的 SFG 結束分支
- 點擊進入 FG 的 `_resetForFreeGame()`

SFG 期間地圖不重置，尊位因此跟著整段延續，不會每局跳動。

尊位定義集中在 `JP_BOSSES`（圖示、名稱、標籤、主色、光暈色、金額），取代原本散在 `drawJPBars`、`drawBossCardPick`、`updateBossCardPick` 三處各寫一次的重複定義。連帶移除永遠為空、只用來查 JP 金額的 `monsters` 陣列。

### 公布時機

`tmAnim.stepIdx === 3` 那次動畫（完成第 4 步）：

- emoji 由 🗺️ 換成該尊的 ⚡ / 👑
- 文字由「獲得藏寶圖！」換成「本局 JP：⚡ 宙斯」（bold 13px 量測寬 106px，面板寬 200px）
- 光暈與文字色改用該尊的主色／光暈色

`updateTMAnim()` 在這次動畫結束時把 `questReveal` 推到 4、第 5 格雲霧散去，時序與公布動畫剛好銜接。第 5 步達成的 🏆「獲得JP！」動畫不變。

### 地標帶

第 5 格（科爾基斯聖林）的 `bandColor` 由固定紫 `#c4b5fd` 改為 `JP_BOSSES[jpBoss].color`，外框、旗子、名牌邊框一起變色；名牌地名保留並在尾端加該尊圖示 → `JP 科爾基斯聖林 ⚡`。無美術圖時的備援節點繪製同步處理。

揭露前該格有雲霧遮罩，不會提前洩漏。

### 發放

連爆結束（`win === 0`）分支中，原本開抽牌的區塊改為：

```js
if (questProgress >= 5 && !jpGranted) { jpGranted = true; grantJpBoss(); }
```

`grantJpBoss()` 把該尊金額加進 `totalScore` 並播報獎動畫。`jpGranted` 避免同一輪地圖重複發放 —— SFG 中 `questProgress` 跨局不重置，而進階合成在 FG／SFG 也會觸發（見 [2026-08-03-map-rule-v2-design.md](2026-08-03-map-rule-v2-design.md) 的「後續修正」），所以第 5 關在 SFG 是真的到得了，這個旗標不是純防呆。

### 移除範圍

`bossCardPick` 狀態物件、`updateBossCardPick()`、`drawBossCardPick()`（128 行）、click 與 mousemove 的抽牌處理，以及散在 `startSpin`／`updateShowingWin`／`updatePopping`／`updateGravity`／SYNTHESIS／IDLE 共 10 處的「抽牌中暫停」判斷。調校面板的 `cardPickResult`（翻牌結果停留）一併移除。

INFO 說明頁「▌ 宙斯 / 赫拉 JP」段落改寫為新流程。

## 驗證

瀏覽器實跑：

- 強開「4色合成」跑完整輪 → `questProgress` 5、`jpGranted` true、`totalScore` +999,999、報獎動畫 label `⚡ 宙斯`、全程未出現抽牌介面
- 手動擺出 `jpBoss=1` 的第 4 步完成狀態 → 公布動畫顯示 👑 與粉色「本局 JP：👑 赫拉」，動畫結束後第 5 格揭開並呈粉色外框、名牌 `JP 科爾基斯聖林 👑`

## 未決

`jpBoss` 目前純隨機五五開，與宙斯 999,999／赫拉 888,888 的金額差沒有掛勾（與原抽牌的期望值相同）。若企劃要加權，改 `rollJpBoss()` 一行即可。
