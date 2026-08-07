/* =============================================================================
 * sim-v3-core.js — 亞格號 demo「V3 規則」純函式模擬核心
 * -----------------------------------------------------------------------------
 * 來源：index.html（RULE_VERSION === 3 的分支），2026-08-07 抽出。
 * 本檔 **完全不碰 canvas / DOM / requestAnimationFrame**，所有動畫節流一律移除，
 * 只保留資料流：合成 → 進階合成 → 算獎 → 消除 → 補牌 → 再掃描，直到 calcWin()===0。
 *
 * 對照的原始行號（index.html，2026-08-07 版）：
 *   PAYOUTS ............... 808-819
 *   COLS/ROWS ............. 538-539
 *   randomSymId ........... 1340-1351
 *   startSpin 生盤 ........ 1626-1663
 *   NG 初次 FG/SFG 偵測 ... 1725-1737
 *   computeCurrentWays .... 1744-1759
 *   findBaseSynthCandidates 1764-1783
 *   applySingleSynthesis .. 1801-1831
 *   applyShipMerge ........ 1834-1846
 *   applyAdvancedSynthesis  1850-1890
 *   findAdvSynthPairs ..... 1893-1912
 *   calcWin ............... 1992-2063
 *   updatePopping(消除) ... 2354-2388
 *   applyGravity(補牌) .... 2711-2742
 *   cascade 主迴圈 ........ 4275-4480
 *   buildQuestPlan ........ 974-1006
 *   requestQuestAdvance … . 1020-1118
 *   v3ColorCleared/… ...... 1290-1311
 *   grantJpBoss ........... 4085-4091
 *   _resetForFreeGame ..... 5965-5982
 *
 * 【同步化說明（任務佇列節流）】
 * 原版 updateQuestPending() 靠 tmAnim / mapMaskAnim 節流，一幀最多推進一關。
 * 預設 TIMING 下（TF = round(sec*60)）：
 *   一次基礎合成 = synthMark 6f + synthFlash 48f + synthSplit 9f = 63 幀
 *   一次關卡推進的封鎖窗 = mapQuest 90f（tmAnim，同時擋住合成佇列）
 *                        + mapMask 6f（只擋 questPending 的抽取，不擋合成）
 * 合成佇列在 tmAnim 結束後才會啟動下一個 op，而下一次 applySingleSynthesis()
 * 距離 tmAnim 結束還有 mark(6)+flash(48)=54 幀 >> mapMask 的 6 幀，
 * 因此「下一次合成發生時 questPending 必為空」。
 * ⇒ 每做完一次基礎合成就同步把佇列抽乾（pumpQuest），與逐幀版等價。
 * 詳細推導與測試案例見 sim-v3.html 的 QUEUE_CONVERGENCE 測試。
 * ========================================================================== */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- 常數
  const COLS = 5, ROWS = 4;

  // PAYOUTS[symId] = [rate3, rate4, rate5]  (index.html:808)
  const PAYOUTS = [
    [0.10, 0.15, 0.30], // 0 海克力斯（紅 char）
    [0.10, 0.15, 0.20], // 1 木棒    （紅 weapon）
    [0.20, 0.30, 0.40], // 2 伊阿宋  （金 char）
    [0.10, 0.15, 0.25], // 3 刀盾    （金 weapon）
    [0.10, 0.15, 0.30], // 4 美狄亞  （藍 char）
    [0.10, 0.15, 0.20], // 5 魔法    （藍 weapon）
    [0.10, 0.15, 0.30], // 6 奧菲斯  （綠 char）
    [0.10, 0.15, 0.20], // 7 七弦琴  （綠 weapon）
    [0, 0, 0],          // 8 船頭
    [0, 0, 0],          // 9 船尾
  ];

  const V3_MULT        = [1, 1, 1, 1, 1];   // v3 無盤面倍數
  const V2_FORK_COLORS = [0, 1];            // 紅(0)=宙斯 / 金(1)=赫拉
  const FG_TOTAL_SPINS  = 10;
  const SFG_TOTAL_SPINS = 10;
  const DEFAULT_JP_NODES = 2;
  const JP_BOSSES = [
    { idx: 0, name: '宙斯', value: 999999 },
    { idx: 1, name: '赫拉', value: 888888 },
  ];

  // ---------------------------------------------------------------- RNG
  // mulberry32：可重現的偽隨機（正式跑大量樣本時換 seed 即可）
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- 狀態
  function initGameState(opts) {
    opts = opts || {};
    const S = {
      rand: opts.rand || makeRng(opts.seed === undefined ? 12345 : opts.seed),
      JP_NODES: opts.jpNodes === undefined ? DEFAULT_JP_NODES : opts.jpNodes,
      // 賠率縮放係數：PAYOUTS 表整體等比縮放（相對關係不變），1 = demo 原值
      payoutCoef: opts.payoutCoef === undefined ? 1 : opts.payoutCoef,
      board: [],
      splitCount: [1, 1, 1, 1],
      synthesizedColors: new Set(),
      mergedCells: [],
      winLines: [],
      // 任務
      questPlan: [], questProgress: 0, questRoute: -1,
      questPending: [], questEventSeq: 0, questAdvSeq: -1, questStage4Seq: -1,
      questScoreMultiplier: 1,
      // JP
      jpIslandSeq: -1, jpNodesLit: 0, jpAdvQueue: [], jpGranted: false,
      // FG / SFG
      inFG: false, inSFG: false, fgSpinsLeft: 0, sfgSpinsLeft: 0,
      shipFGPending: false, shipSFGPending: false,
      // 本次 spin 的觀測值
      _obs: null,
    };
    for (let c = 0; c < COLS; c++) { S.board[c] = []; for (let r = 0; r < ROWS; r++) S.board[c][r] = { id: -1 }; }
    buildQuestPlan(S);
    return S;
  }

  // ---------------------------------------------------------------- 版本能力
  const isForkRule = () => true;   // v3
  const isV3       = () => true;
  const hasMapIslands = () => false;
  const questStepCount = () => 4;
  // 2026-08-07 修正（同步 index.html）：分裂由地圖通關給予，地圖在 FG 內不重置，
  // 分裂自然也不該每局歸零 → 保留條件與 mapPersists 同步（FG／SFG 都保留）。
  const splitAccumulates = S => (S.inFG || S.inSFG);
  // 上限與「是否跨局保留」是兩件事：FG 保留但上限仍 2×1，只有 SFG 放寬到 4×1。
  const maxSplitCap      = S => (S.inSFG ? 4 : 2);
  const mapPersists      = S => (S.inFG || S.inSFG);
  const jpTrackOpen      = S => S.questRoute >= 0;

  // ---------------------------------------------------------------- 任務
  function buildQuestPlan(S) {
    S.questRoute = -1;
    S.questPending = []; S.jpAdvQueue = [];
    S.questEventSeq = 0; S.questStage4Seq = -1; S.questAdvSeq = -1;
    S.jpIslandSeq = -1; S.jpNodesLit = 0;
    S.questPlan = [
      { colors: V2_FORK_COLORS.slice(), kind: 'synth', fork: true },
      { colors: [], kind: 'synth', fork: false },
      { colors: [], kind: 'synth', fork: false },
      { colors: [], kind: 'synth', fork: false },
    ];
    S.jpGranted = false;
  }

  function applyQuestReward(S) {
    S.questScoreMultiplier = V3_MULT[S.questProgress] !== undefined
      ? V3_MULT[S.questProgress] : V3_MULT[V3_MULT.length - 1];
  }

  function requestQuestAdvance(S, colors, tieBreak) {
    S.questPending.push({ colors: colors.slice(), tieBreak, seq: ++S.questEventSeq, atProgress: S.questProgress });
    return S.questEventSeq;
  }

  function fillRemainingSteps(S, winColor) {
    const rest = [0, 1, 2, 3].filter(c => c !== winColor);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(S.rand() * (i + 1));
      const t = rest[i]; rest[i] = rest[j]; rest[j] = t;
    }
    rest.forEach((c, k) => { if (S.questPlan[k + 1]) S.questPlan[k + 1].colors = [c]; });
  }

  function tryAdvanceQuest(S, colorIds, tieBreak, seq) {
    if (S.questProgress >= questStepCount()) return false;
    const step = S.questPlan[S.questProgress];
    if (!step || step.kind !== 'synth') return false;
    const hit = step.colors.filter(c => colorIds.includes(c));
    if (!hit.length) return false;
    if (step.fork) {
      const win = (hit.length > 1 && hit.includes(tieBreak)) ? tieBreak : hit[0];
      S.questRoute = V2_FORK_COLORS.indexOf(win);
      step.colors = [win];
      S.jpIslandSeq = seq;
      fillRemainingSteps(S, win);
    }
    S.questProgress++;
    if (S.questProgress === 4) S.questStage4Seq = seq;
    applyQuestReward(S);
    return true;
  }

  // 同步版 updateQuestPending()：跑到不動點
  function pumpQuest(S) {
    for (;;) {
      let advanced = false;
      while (S.questPending.length) {
        const q = S.questPending.shift();
        if (q.atProgress !== S.questProgress) continue;     // 揭露前的合成 → 作廢
        if (tryAdvanceQuest(S, q.colors, q.tieBreak, q.seq)) { advanced = true; break; }
      }
      if (!advanced) break;
    }
    // JP 收集點（v3：石像旁的羅盤，一次點一個）
    while (S.jpAdvQueue.length) {
      const seq = S.jpAdvQueue.shift();
      if (!jpTrackOpen(S) || seq <= S.jpIslandSeq) continue;  // 定案前（含定案當次）不計入
      if (S.jpNodesLit >= S.JP_NODES) continue;
      S.jpNodesLit++;
      if (S._obs) S._obs.beacons++;
    }
  }

  // v3 分裂規則（index.html:1294-1311）
  function v3ColorCleared(S, colorId) {
    for (let i = 0; i < S.questProgress && i < S.questPlan.length; i++) {
      const s = S.questPlan[i];
      if (s && s.kind === 'synth' && s.colors.includes(colorId)) return true;
    }
    return false;
  }
  function v3ClearsNow(S, colorId) {
    if (S.questProgress >= questStepCount()) return false;
    const step = S.questPlan[S.questProgress];
    if (!step || step.kind !== 'synth' || !step.colors.includes(colorId)) return false;
    return !S.questPending.some(q => q.atProgress === S.questProgress
      && q.colors.some(c => step.colors.includes(c)));
  }
  const v3CanSplit = (S, colorId) => v3ColorCleared(S, colorId) || v3ClearsNow(S, colorId);

  // ---------------------------------------------------------------- 盤面工具
  const isShipCell = cell => !!cell && cell.isMerged && cell.colorId === -1;

  function randomSymId(S) {
    const weights = (S.inFG || S.inSFG)
      ? [9, 15, 9, 15, 9, 15, 9, 15]         // FG/SFG 無船符號（共 96）
      : [9, 15, 9, 15, 9, 15, 9, 15, 2, 2];  // NG 共 100
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = S.rand() * total;
    for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
    return weights.length - 1;
  }

  function scanShipSymbols(S) {
    let bow = false, stern = false;
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      const cell = S.board[c] && S.board[c][r];
      if (!cell) continue;
      if (isShipCell(cell)) { bow = true; stern = true; }
      else if (cell.id === 8) bow = true;
      else if (cell.id === 9) stern = true;
    }
    return { bow, stern };
  }
  function colHasShipSymbol(S, c) {
    return (S.board[c] || []).some(cell => cell && (cell.id === 8 || cell.id === 9 || isShipCell(cell)));
  }

  function computeCurrentWays(S) {
    let total = 1;
    for (let col = 0; col < COLS; col++) {
      let colTotal = 0;
      for (let row = 0; row < ROWS; row++) {
        const cell = S.board[col][row];
        if (!cell) { colTotal += 1; continue; }
        if (cell.isMerged) { const cid = cell.colorId; colTotal += (cid >= 0 ? S.splitCount[cid] : 1); continue; }
        if (cell.id >= 0 && cell.id < 8) colTotal += S.splitCount[Math.floor(cell.id / 2)];
        else colTotal += 1;
      }
      total *= Math.max(1, colTotal);
    }
    return total;
  }

  // ---------------------------------------------------------------- 合成
  function findBaseSynthCandidates(S) {
    const ops = [];
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS - 1; col++) {
        const a = S.board[col][row], b = S.board[col + 1][row];
        if (!a || !b || a.isMerged || b.isMerged) continue;
        if (a.id === undefined || a.id < 0 || a.id >= 8) continue;
        if (b.id === undefined || b.id < 0 || b.id >= 8) continue;
        const aC = Math.floor(a.id / 2), bC = Math.floor(b.id / 2);
        const aChar = (a.id % 2 === 0), bChar = (b.id % 2 === 0);
        if (aC === bC && aChar !== bChar) ops.push({ col, row, colorId: aC });
      }
    }
    return ops;
  }

  function applySingleSynthesis(S, col, row) {
    const a = S.board[col][row];
    const b = S.board[col + 1] && S.board[col + 1][row];
    if (!a || !b || a.isMerged || b.isMerged) return false;
    const colorId = Math.floor(a.id / 2);
    const displayCount = S.splitCount[colorId] || 1;
    const MAX_SPLIT = maxSplitCap(S);
    // v3：合成本身不給分裂，分裂＝地圖通關的獎勵，通關即直接切到上限
    if (v3CanSplit(S, colorId)) {
      if (S.splitCount[colorId] !== MAX_SPLIT && S._obs) S._obs.splitEvents++;
      S.splitCount[colorId] = MAX_SPLIT;
    }
    S.synthesizedColors.add(colorId);
    const mergeId = S.mergedCells.length;
    S.board[col][row]     = { id: -1, isMerged: true, mergeId, colorId, mergeSize: 2, mergeCol: col, mergeRow: row, isMergeSlave: false, isMatched: false };
    S.board[col + 1][row] = { id: -1, isMerged: true, mergeId, colorId, mergeSize: 2, mergeCol: col, mergeRow: row, isMergeSlave: true,  isMatched: false };
    S.mergedCells.push({ col, row, colorId, size: 2, displayCount });
    requestQuestAdvance(S, [colorId], colorId);
    if (S._obs) S._obs.baseSynth++;
    return true;
  }

  function applyShipMerge(S) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS - 1; c++) {
        const ca = S.board[c] && S.board[c][r], cb = S.board[c + 1] && S.board[c + 1][r];
        if (!ca || !cb || ca.isMerged || cb.isMerged) continue;
        if (!((ca.id === 8 && cb.id === 9) || (ca.id === 9 && cb.id === 8))) continue;
        const mergeId = S.mergedCells.length;
        S.board[c][r]     = { id: -1, isMerged: true, mergeId, colorId: -1, mergeSize: 2, mergeCol: c, mergeRow: r, isMergeSlave: false, isMatched: false };
        S.board[c + 1][r] = { id: -1, isMerged: true, mergeId, colorId: -1, mergeSize: 2, mergeCol: c, mergeRow: r, isMergeSlave: true,  isMatched: false };
        S.mergedCells.push({ col: c, row: r, colorId: -1, size: 2, displayCount: 1, isShipMerge: true });
      }
    }
  }

  function findAdvSynthPairs(S) {
    if (S.shipFGPending || S.shipSFGPending) return [];
    const pairs = [], used = new Set();
    for (let i = 0; i < S.mergedCells.length; i++) {
      const mA = S.mergedCells[i];
      if (mA.size !== 2 || mA.upgraded || mA.isShipMerge || used.has(i)) continue;
      for (let j = i + 1; j < S.mergedCells.length; j++) {
        const mB = S.mergedCells[j];
        if (mB.size !== 2 || mB.upgraded || mB.isShipMerge || used.has(j)) continue;
        if (mA.row !== mB.row || mA.colorId === mB.colorId) continue;
        const leftM = mA.col < mB.col ? mA : mB, rightM = mA.col < mB.col ? mB : mA;
        if (leftM.col + 2 !== rightM.col) continue;
        pairs.push(leftM, rightM); used.add(i); used.add(j);
      }
    }
    return pairs;
  }

  function applyAdvancedSynthesis(S) {
    if (S.shipFGPending || S.shipSFGPending) return;
    for (let i = 0; i < S.mergedCells.length; i++) {
      const mA = S.mergedCells[i];
      if (mA.size !== 2 || mA.upgraded || mA.isShipMerge) continue;
      for (let j = i + 1; j < S.mergedCells.length; j++) {
        const mB = S.mergedCells[j];
        if (mB.size !== 2 || mB.upgraded || mB.isShipMerge) continue;
        if (mA.row !== mB.row || mA.colorId === mB.colorId) continue;
        const leftM = mA.col < mB.col ? mA : mB, rightM = mA.col < mB.col ? mB : mA;
        if (leftM.col + 2 !== rightM.col) continue;
        const displayCount4 = Math.max(leftM.displayCount || 1, rightM.displayCount || 1);
        // v3：進階合成不給分裂，只計入 JP 收集點
        const newMerge = { col: leftM.col, row: leftM.row, colorId: leftM.colorId, colorId2: rightM.colorId, size: 4, displayCount: displayCount4 };
        leftM.upgraded = true; rightM.upgraded = true;
        S.mergedCells.push(newMerge);
        for (let c = leftM.col; c < leftM.col + 4; c++) {
          S.board[c][leftM.row] = {
            id: -1, isMerged: true, mergeId: S.mergedCells.length - 1,
            colorId: leftM.colorId, colorId2: rightM.colorId,
            mergeSize: 4, mergeCol: leftM.col, mergeRow: leftM.row,
            isMergeSlave: (c !== leftM.col), isMatched: false,
          };
        }
        S.questAdvSeq = ++S.questEventSeq;
        S.jpAdvQueue.push(S.questAdvSeq);
        if (S._obs) S._obs.advSynth++;
      }
    }
    S.mergedCells = S.mergedCells.filter(m => !m.upgraded);
  }

  // ---------------------------------------------------------------- 算獎
  function calcWin(S, bet) {
    let totalWin = 0;
    S.winLines = [];
    for (let symId = 0; symId < 8; symId++) {
      const colorId = Math.floor(symId / 2);
      const split = S.splitCount[colorId];
      const colCounts = [];
      for (let col = 0; col < COLS; col++) {
        let regCount = 0, mergeCount = 0;
        for (let row = 0; row < ROWS; row++) {
          const cell = S.board[col][row];
          if (!cell.isMerged && cell.id === symId) regCount++;
          else if (cell.isMerged) {
            const cids = cell.colorId2 !== undefined ? [cell.colorId, cell.colorId2] : [cell.colorId];
            if (cids.indexOf(colorId) >= 0) mergeCount++;
          }
        }
        colCounts.push(regCount * split + mergeCount);
      }
      let matchCount = 0, ways = 1;
      for (let col = 0; col < COLS; col++) {
        if (colCounts[col] === 0) break;
        matchCount++; ways *= colCounts[col];
      }
      if (matchCount >= 3) {
        // 賠率係數：整張 PAYOUTS 等比縮放（相對關係不變），1 = demo 原值。
        // 注意 floor() 在此之後 —— 係數愈小、無條件捨去的相對損失愈大，
        // 所以 RTP 對係數並非嚴格線性，校準必須實掃而不能用比例外推。
        const rate = PAYOUTS[symId][matchCount - 3] * (S.payoutCoef || 1);
        const symWin = Math.floor(bet * rate * ways);
        totalWin += symWin;
        const cells = [];
        for (let col = 0; col < matchCount; col++) {
          for (let row = 0; row < ROWS; row++) {
            const cell = S.board[col][row];
            if (!cell.isMerged && cell.id === symId) cells.push([col, row]);
            else if (cell.isMerged && !cell.isMergeSlave) {
              const cids = cell.colorId2 !== undefined ? [cell.colorId, cell.colorId2] : [cell.colorId];
              if (cids.indexOf(colorId) >= 0) {
                cells.push([col, row]);
                const sz = cell.mergeSize || 2;
                for (let dc = 1; dc < sz; dc++) {
                  const slave = S.board[col + dc] && S.board[col + dc][row];
                  if (slave && slave.isMergeSlave) cells.push([col + dc, row]);
                }
              }
            }
          }
        }
        S.winLines.push({ symId, matchCount, ways, win: symWin, cells });
      }
    }
    return totalWin;
  }

  // 消除 + 補牌（updatePopping phase2 + applyGravity 的資料流部分）
  function markWinCells(S) {
    S.winLines.forEach(g => g.cells.forEach(([c, r]) => {
      const cell = S.board[c] && S.board[c][r];
      if (!cell || cell.isMatched) return;
      cell.isMatched = true;
    }));
  }
  function popAndRefill(S) {
    S.mergedCells = S.mergedCells.filter(m => {
      const master = S.board[m.col] && S.board[m.col][m.row];
      if (!master || !master.isMatched) return true;
      for (let dc = 1; dc < (m.size || 2); dc++) {
        const slave = S.board[m.col + dc] && S.board[m.col + dc][m.row];
        if (slave) slave.isMatched = true;
      }
      return false;
    });
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++)
      if (S.board[c][r].isMatched) S.board[c][r] = { id: -1, isMatched: false };
    // applyGravity：對空格原地補新符號
    const scan = scanShipSymbols(S);
    let hasBow = scan.bow, hasStern = scan.stern;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (S.board[c][r].id === -1 && !S.board[c][r].isMerged) {
          const colHasFG = colHasShipSymbol(S, c);
          let id = randomSymId(S);
          while (id >= 8 && !((id === 8 && !hasBow && !colHasFG) || (id === 9 && !hasStern && !colHasFG))) id = randomSymId(S);
          if (id === 8) hasBow = true;
          if (id === 9) hasStern = true;
          S.board[c][r] = { id, isMatched: false };
        }
      }
    }
  }

  // ---------------------------------------------------------------- 一局
  function resetRoundState(S) {
    if (!splitAccumulates(S)) S.splitCount = [1, 1, 1, 1];
    S.synthesizedColors = new Set();
    S.mergedCells = [];
    S.winLines = [];
    S.questPending = []; S.jpAdvQueue = [];
    if (!mapPersists(S)) {
      S.questProgress = 0;
      S.questScoreMultiplier = 1;
      buildQuestPlan(S);
    }
  }

  function generateBoard(S) {
    // 舊盤面殘留的船頭／船尾會抑制本局生成（index.html:1631-1632）
    let hasBow = false, hasStern = false;
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      const cell = S.board[c] && S.board[c][r];
      if (cell && cell.id === 8) hasBow = true;
      if (cell && cell.id === 9) hasStern = true;
    }
    for (let c = 0; c < COLS; c++) {
      S.board[c] = [];
      let colHasFG = false;
      for (let r = 0; r < ROWS; r++) {
        let id = randomSymId(S);
        while (id >= 8 && !((id === 8 && !hasBow && !colHasFG) || (id === 9 && !hasStern && !colHasFG))) id = randomSymId(S);
        if (id === 8) { hasBow = true; colHasFG = true; }
        if (id === 9) { hasStern = true; colHasFG = true; }
        S.board[c][r] = { id, isMatched: false };
      }
    }
  }

  function findShipPositions(S) {
    let bow = null, stern = null;
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      const cell = S.board[c] && S.board[c][r];
      if (!cell) continue;
      if (cell.id === 8) bow = { c, r };
      if (cell.id === 9) stern = { c, r };
    }
    return { bow, stern };
  }

  // 跑完一局（含整串 cascade）。mode: 'NG' | 'FG' | 'SFG'
  function simulateOneSpin(S, bet) {
    const mode = S.inSFG ? 'SFG' : (S.inFG ? 'FG' : 'NG');
    if (S.inFG) S.fgSpinsLeft--;
    if (S.inSFG) S.sfgSpinsLeft--;

    const obs = {
      mode, win: 0, cascades: 0, baseSynth: 0, advSynth: 0, splitEvents: 0,
      beacons: 0, jpValue: 0, jpBoss: -1, jpHit: false,
      stageReached: 0, maxWays: 0, maxSplit: 1,
      triggerFG: false, triggerSFG: false,
    };
    S._obs = obs;

    resetRoundState(S);
    generateBoard(S);

    // NG 初次偵測：船頭＋船尾同時出現且不相鄰 → FG（index.html:1725-1737）
    if (!S.inFG && !S.inSFG) {
      const p = findShipPositions(S);
      if (p.bow && p.stern) {
        const adj = Math.abs(p.bow.c - p.stern.c) <= 1 && p.bow.r === p.stern.r;
        if (!adj) S.shipFGPending = true;
      }
    }

    let winScore = 0;
    let guard = 0;
    for (;;) {
      if (++guard > 2000) throw new Error('cascade guard tripped');

      // ---- SYNTHESIS 進入點（等價於 synthOpIdx === -1 的初始化 ----
      let shipFound = false;
      if (!S.inFG && !S.inSFG && !S.shipFGPending && !S.shipSFGPending) {
        outer:
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS - 1; c++) {
            const ca = S.board[c] && S.board[c][r], cb = S.board[c + 1] && S.board[c + 1][r];
            if (ca && cb && !ca.isMerged && !cb.isMerged &&
                ((ca.id === 8 && cb.id === 9) || (ca.id === 9 && cb.id === 8))) {
              S.shipSFGPending = true;
              shipFound = true;
              break outer;
            }
          }
        }
        if (shipFound) applyShipMerge(S);
      }
      if (!shipFound && !S.inFG && !S.inSFG && !S.shipFGPending && !S.shipSFGPending) {
        const p = findShipPositions(S);
        if (p.bow && p.stern) {
          const adj = Math.abs(p.bow.c - p.stern.c) <= 1 && p.bow.r === p.stern.r;
          if (!adj) S.shipFGPending = true;
        }
      }

      // ---- 基礎合成佇列：一個一個做，每做完一個就把任務佇列抽乾 ----
      const ops = findBaseSynthCandidates(S);
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const a = S.board[op.col] && S.board[op.col][op.row];
        const b = S.board[op.col + 1] && S.board[op.col + 1][op.row];
        if (!a || !b || a.isMerged || b.isMerged) continue;
        applySingleSynthesis(S, op.col, op.row);
        pumpQuest(S);
      }

      // ---- 進階合成（必須在 calcWin 之前）----
      if (findAdvSynthPairs(S).length > 0) applyAdvancedSynthesis(S);
      pumpQuest(S);

      for (let ci = 0; ci < 4; ci++) if (S.splitCount[ci] > obs.maxSplit) obs.maxSplit = S.splitCount[ci];
      const ways = computeCurrentWays(S);
      if (ways > obs.maxWays) obs.maxWays = ways;

      // ---- 結算 ----
      const win = calcWin(S, bet);
      if (win > 0) {
        winScore += Math.floor(win * S.questScoreMultiplier);
        obs.cascades++;
        markWinCells(S);
        popAndRefill(S);
        continue;
      }

      // 連爆結束（先記錄，resetAfterFreeGame 會把進度歸零）
      obs.stageReached = S.questProgress;
      obs.nodesLit = S.jpNodesLit;
      obs.route = S.questRoute;   // -1 未定 / 0 紅(宙斯) / 1 金(赫拉)
      const jpDone = jpTrackOpen(S) && S.jpNodesLit >= S.JP_NODES;
      if (jpDone && !S.jpGranted) {
        S.jpGranted = true;
        const boss = JP_BOSSES[S.questRoute];
        if (boss) { obs.jpHit = true; obs.jpBoss = boss.idx; obs.jpValue = boss.value; }
      }
      if (S.shipSFGPending) { S.shipSFGPending = false; obs.triggerSFG = true; }
      else if (S.shipFGPending) { S.shipFGPending = false; obs.triggerFG = true; }
      else if (S.inSFG && S.sfgSpinsLeft <= 0) { S.inSFG = false; obs.sfgEnded = true; resetAfterFreeGame(S); }
      else if (S.inFG && S.fgSpinsLeft <= 0) { S.inFG = false; obs.fgEnded = true; resetAfterFreeGame(S); }
      break;
    }

    obs.win = winScore;
    S._obs = null;
    return obs;
  }

  function resetAfterFreeGame(S) {
    S.splitCount = [1, 1, 1, 1];
    S.questProgress = 0; S.questScoreMultiplier = 1;
    buildQuestPlan(S);
  }

  // 進場 FG / SFG（等價於玩家點 START 之後的 _resetForFreeGame + 設定局數）
  function enterFreeGame(S, kind) {
    S.splitCount = [1, 1, 1, 1];
    S.questProgress = 0; S.questScoreMultiplier = 1;
    buildQuestPlan(S);
    if (kind === 'SFG') { S.inSFG = true; S.sfgSpinsLeft = SFG_TOTAL_SPINS; }
    else                { S.inFG = true;  S.fgSpinsLeft = FG_TOTAL_SPINS; }
  }

  // 跑完整串免費遊戲
  function simulateFreeGameChain(S, bet, kind) {
    enterFreeGame(S, kind);
    const out = {
      kind, totalWin: 0, spins: 0, jpValue: 0, jpCount: 0, jpBossCounts: [0, 0],
      stageReached: 0, maxWays: 0, maxSplit: 1, cascades: 0,
      baseSynth: 0, advSynth: 0, splitEvents: 0, hits: 0, spinWins: [], perSpin: [],
    };
    let guard = 0;
    while ((S.inFG || S.inSFG)) {
      if (++guard > 100) throw new Error('FG chain guard tripped');
      const o = simulateOneSpin(S, bet);
      out.spins++;
      out.totalWin += o.win;
      out.spinWins.push(o.win);
      out.perSpin.push(o);
      if (o.win > 0) out.hits++;
      out.cascades += o.cascades;
      out.baseSynth += o.baseSynth;
      out.advSynth += o.advSynth;
      out.splitEvents += o.splitEvents;
      if (o.jpHit) { out.jpCount++; out.jpValue += o.jpValue; out.jpBossCounts[o.jpBoss]++; }
      if (o.stageReached > out.stageReached) out.stageReached = o.stageReached;
      if (o.maxWays > out.maxWays) out.maxWays = o.maxWays;
      if (o.maxSplit > out.maxSplit) out.maxSplit = o.maxSplit;
      out.nodesLit = o.nodesLit;
    }
    return out;
  }

  // 一次押注 = 1 局 NG（＋觸發到的 FG/SFG 整串）
  function simulateOneWager(S, bet) {
    const ng = simulateOneSpin(S, bet);
    const rec = {
      bet,
      ngWin: ng.win, fgWin: 0, sfgWin: 0,
      totalWin: ng.win,
      jpCount: ng.jpHit ? 1 : 0,
      jpBossCounts: [0, 0],
      ng, fg: null, sfg: null,
    };
    if (ng.jpHit) rec.jpBossCounts[ng.jpBoss]++;
    if (ng.triggerSFG) {
      const chain = simulateFreeGameChain(S, bet, 'SFG');
      rec.sfg = chain; rec.sfgWin = chain.totalWin; rec.totalWin += chain.totalWin;
      rec.jpCount += chain.jpCount;
      rec.jpBossCounts[0] += chain.jpBossCounts[0]; rec.jpBossCounts[1] += chain.jpBossCounts[1];
    } else if (ng.triggerFG) {
      const chain = simulateFreeGameChain(S, bet, 'FG');
      rec.fg = chain; rec.fgWin = chain.totalWin; rec.totalWin += chain.totalWin;
      rec.jpCount += chain.jpCount;
      rec.jpBossCounts[0] += chain.jpBossCounts[0]; rec.jpBossCounts[1] += chain.jpBossCounts[1];
    }
    return rec;
  }

  // ---------------------------------------------------------------- 統計
  function makeAcc() {
    return {
      spins: 0, hits: 0, win: 0, wins: [], max: 0,
      baseSynthSpins: 0, advSynthSpins: 0, splitSpins: 0,
      baseSynthSum: 0, advSynthSum: 0, splitSum: 0,
      cascades: 0, maxCascades: 0, stageSum: 0, stageHist: [0, 0, 0, 0, 0], maxWays: 0,
      nodesSum: 0, nodeHist: [0, 0, 0, 0, 0], jpHits: 0,
      route: [0, 0], routeDecided: 0,
      dist: null,
    };
  }
  function pushSpin(acc, o, bet) {
    acc.spins++;
    acc.win += o.win;
    acc.wins.push(o.win);
    if (o.win > 0) acc.hits++;
    if (o.win > acc.max) acc.max = o.win;
    if (o.baseSynth > 0) acc.baseSynthSpins++;
    if (o.advSynth > 0) acc.advSynthSpins++;
    if (o.splitEvents > 0) acc.splitSpins++;
    acc.baseSynthSum += o.baseSynth;
    acc.advSynthSum += o.advSynth;
    acc.splitSum += o.splitEvents;
    acc.cascades += o.cascades;
    if (o.cascades > acc.maxCascades) acc.maxCascades = o.cascades;
    acc.stageSum += o.stageReached;
    acc.stageHist[Math.min(4, o.stageReached)]++;
    acc.nodesSum += (o.nodesLit || 0);
    acc.nodeHist[Math.min(4, o.nodesLit || 0)]++;
    if (o.jpHit) acc.jpHits++;
    if (o.route === 0 || o.route === 1) { acc.route[o.route]++; acc.routeDecided++; }
    if (o.maxWays > acc.maxWays) acc.maxWays = o.maxWays;
    if (bet !== undefined) {
      if (!acc.dist) acc.dist = DIST_BUCKETS.map(() => 0);
      for (let k = 0; k < DIST_BUCKETS.length; k++) if (DIST_BUCKETS[k][1](o.win, bet)) { acc.dist[k]++; break; }
    }
  }
  function summarize(acc, bet) {
    const n = acc.spins || 1;
    const arr = acc.wins.slice().sort((a, b) => a - b);
    const mean = acc.win / n;
    let v = 0; for (let i = 0; i < acc.wins.length; i++) { const d = acc.wins[i] - mean; v += d * d; }
    const sd = Math.sqrt(v / n);
    const median = arr.length ? (arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2) : 0;
    return {
      spins: acc.spins,
      hits: acc.hits,
      hitRate: acc.hits / n,
      totalWin: acc.win,
      avgWin: mean,
      medianWin: median,
      maxWin: acc.max,
      sd,
      avgWinX: mean / bet,
      maxWinX: acc.max / bet,
      synthRate: acc.baseSynthSpins / n,
      advSynthRate: acc.advSynthSpins / n,
      splitRate: acc.splitSpins / n,
      avgSynth: acc.baseSynthSum / n,
      avgAdvSynth: acc.advSynthSum / n,
      avgSplit: acc.splitSum / n,
      avgCascades: acc.cascades / n,
      maxCascades: acc.maxCascades,
      avgStage: acc.stageSum / n,
      stageHist: acc.stageHist.slice(),
      stageReachRate: [1, 2, 3, 4].map(k => acc.stageHist.reduce((s, v, i) => s + (i >= k ? v : 0), 0) / n),
      avgNodes: acc.nodesSum / n,
      nodeHist: acc.nodeHist.slice(),
      jpHits: acc.jpHits,
      jpRate: acc.jpHits / n,
      route: acc.route.slice(),
      routeDecided: acc.routeDecided,
      dist: acc.dist ? acc.dist.slice() : null,
      distPct: acc.dist ? acc.dist.map(v => v / n) : null,
      maxWays: acc.maxWays,
    };
  }

  const DIST_BUCKETS = [
    ['0（未中獎）', w => w === 0],
    ['0 < x ≤ 0.5×', (w, b) => w > 0 && w <= 0.5 * b],
    ['0.5× < x ≤ 1×', (w, b) => w > 0.5 * b && w <= 1 * b],
    ['1× < x ≤ 2×', (w, b) => w > 1 * b && w <= 2 * b],
    ['2× < x ≤ 5×', (w, b) => w > 2 * b && w <= 5 * b],
    ['5× < x ≤ 10×', (w, b) => w > 5 * b && w <= 10 * b],
    ['10× < x ≤ 20×', (w, b) => w > 10 * b && w <= 20 * b],
    ['20× < x ≤ 50×', (w, b) => w > 20 * b && w <= 50 * b],
    ['> 50×', (w, b) => w > 50 * b],
  ];

  function runMonteCarlo(n, bet, opts) {
    opts = opts || {};
    const t0 = Date.now();
    // payoutCoef 必須一併傳入，否則賠率係數掃描會被靜默忽略、永遠跑原始賠率（2026-08-07 修正）
    const S = initGameState({
      seed: opts.seed === undefined ? 20260807 : opts.seed,
      jpNodes: opts.jpNodes,
      payoutCoef: opts.payoutCoef,
    });
    const ng = makeAcc(), fg = makeAcc(), sfg = makeAcc();
    const wagerWins = [];
    const distNG = DIST_BUCKETS.map(() => 0);
    const distWager = DIST_BUCKETS.map(() => 0);
    let fgTrigger = 0, sfgTrigger = 0;
    let jpCount = 0, jpBoss = [0, 0], jpValueExcluded = 0;
    const nodeHist = [0, 0, 0, 0, 0];   // NG 局結束時 jpNodesLit 分布
    const fgNodeHist = [0, 0, 0, 0, 0]; // FG/SFG 串結束時 jpNodesLit
    let fgChains = 0;
    let totalWinAll = 0;

    for (let i = 0; i < n; i++) {
      const rec = simulateOneWager(S, bet);
      pushSpin(ng, rec.ng, bet);
      nodeHist[Math.min(4, rec.ng.nodesLit)]++;
      if (rec.ng.triggerFG) fgTrigger++;
      if (rec.ng.triggerSFG) sfgTrigger++;
      const chain = rec.sfg || rec.fg;
      if (chain) {
        fgChains++;
        fgNodeHist[Math.min(4, chain.nodesLit || 0)]++;
      }
      jpCount += rec.jpCount;
      jpBoss[0] += rec.jpBossCounts[0]; jpBoss[1] += rec.jpBossCounts[1];
      jpValueExcluded += (rec.ng.jpValue || 0) + (rec.fg ? rec.fg.jpValue : 0) + (rec.sfg ? rec.sfg.jpValue : 0);
      totalWinAll += rec.totalWin;
      wagerWins.push(rec.totalWin);
      for (let k = 0; k < DIST_BUCKETS.length; k++) {
        if (DIST_BUCKETS[k][1](rec.ng.win, bet)) { distNG[k]++; break; }
      }
      for (let k = 0; k < DIST_BUCKETS.length; k++) {
        if (DIST_BUCKETS[k][1](rec.totalWin, bet)) { distWager[k]++; break; }
      }
      if (rec.fg)  rec.fg.perSpin.forEach(o => pushSpin(fg, o, bet));
      if (rec.sfg) rec.sfg.perSpin.forEach(o => pushSpin(sfg, o, bet));
    }

    const ngS = summarize(ng, bet), fgS = summarize(fg, bet), sfgS = summarize(sfg, bet);
    const wagerMean = totalWinAll / n;
    let wv = 0; for (let i = 0; i < wagerWins.length; i++) { const d = wagerWins[i] - wagerMean; wv += d * d; }
    const wagerSorted = wagerWins.slice().sort((a, b) => a - b);

    return {
      meta: { n, bet, seed: opts.seed === undefined ? 20260807 : opts.seed, jpNodes: S.JP_NODES,
              ruleVersion: 3, elapsedMs: Date.now() - t0 },
      ng: ngS, fg: fgS, sfg: sfgS,
      wager: {
        n, totalWin: totalWinAll, avgWin: wagerMean,
        medianWin: wagerSorted.length ? (wagerSorted.length % 2 ? wagerSorted[(wagerSorted.length - 1) / 2] : (wagerSorted[wagerSorted.length / 2 - 1] + wagerSorted[wagerSorted.length / 2]) / 2) : 0,
        maxWin: wagerSorted.length ? wagerSorted[wagerSorted.length - 1] : 0,
        sd: Math.sqrt(wv / n),
      },
      trigger: {
        fg: fgTrigger, sfg: sfgTrigger,
        fgRate: fgTrigger / n, sfgRate: sfgTrigger / n,
        fgOneIn: fgTrigger ? n / fgTrigger : null,
        sfgOneIn: sfgTrigger ? n / sfgTrigger : null,
        fgSpins: fg.spins, sfgSpins: sfg.spins,
      },
      jp: {
        count: jpCount, boss: jpBoss, perSpin: jpCount / n,
        oneIn: jpCount ? n / jpCount : null,
        excludedValue: jpValueExcluded,
        ngNodeHist: nodeHist, fgNodeHist, fgChains,
      },
      dist: { labels: DIST_BUCKETS.map(b => b[0]), ng: distNG, wager: distWager },
      rtp: {
        // 規格：分母 = NG 局數 × 押注；FG/SFG 免費局不計入分母；JP 完全排除
        denominator: n * bet,
        numerator: totalWinAll,
        rtp: totalWinAll / (n * bet),
        ngOnly: ngS.totalWin / (n * bet),
        fgPart: fgS.totalWin / (n * bet),
        sfgPart: sfgS.totalWin / (n * bet),
        capTarget: 0.985,
      },
    };
  }

  // ---------------------------------------------------------------- 匯出
  root.SimV3 = {
    COLS, ROWS, PAYOUTS, V3_MULT, V2_FORK_COLORS, FG_TOTAL_SPINS, SFG_TOTAL_SPINS, JP_BOSSES,
    makeRng, initGameState, buildQuestPlan, resetRoundState, generateBoard,
    randomSymId, computeCurrentWays,
    findBaseSynthCandidates, applySingleSynthesis, applyShipMerge,
    findAdvSynthPairs, applyAdvancedSynthesis,
    requestQuestAdvance, tryAdvanceQuest, pumpQuest,
    v3ColorCleared, v3ClearsNow, v3CanSplit,
    calcWin, markWinCells, popAndRefill,
    simulateOneSpin, simulateFreeGameChain, simulateOneWager, runMonteCarlo,
    summarize, makeAcc, pushSpin, DIST_BUCKETS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
