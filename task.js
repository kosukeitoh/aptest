// ====== 設定 ======
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const SOLFEGE_NAMES = ["do","do#","re","re#","mi","fa","fa#","sol","sol#","la","la#","si"];
const LABEL_TO_FILE = {
  "C": "C",
  "C#": "Cis",
  "D": "D",
  "D#": "Dis",
  "E": "E",
  "F": "F",
  "F#": "Fis",
  "G": "G",
  "G#": "Gis",
  "A": "A",
  "A#": "Ais",
  "B": "B"
};
const DISPLAY_LABELS = {
  "C":  "C",
  "C#": "C♯/D♭",
  "D":  "D",
  "D#": "D♯/E♭",
  "E":  "E",
  "F":  "F",
  "F#": "F♯/G♭",
  "G":  "G",
  "G#": "G♯/A♭",
  "A":  "A",
  "A#": "A♯/B♭",
  "B":  "B"
};
const AUDIO_DIR = "audio";

// MIDI範囲に合わせて変更
const MIN_MIDI = 36;  // 036-C2.wav
const MAX_MIDI = 95;  // （必要に応じて調整）

const N_TRIALS = 60;     // 試行数
const TRIAL_MS = 5000;         // 音提示〜次の音まで固定5秒
const START_DELAY_MS = 5000;   // 音量OK後、開始まで5秒


// ====== 状態 ======
let trials = [];
let trialIndex = -1;
let current = null;
let tSoundOn = null;
let canRespond = false;
let results = [];
let subjID = "";
// どちらを表示する？  "sharp" = C/C#表記,  "solfege" = do/re/mi表記
let LABEL_MODE = "sharp";  // ←必要なら "solfege" に

const elStatus = document.getElementById("status");
const btnStart = document.getElementById("btnStart");
const btnDownload = document.getElementById("btnDownload");
const elSubjId = document.getElementById("subjId");
const btnVolPlay = document.getElementById("btnVolPlay");
const btnVolOK   = document.getElementById("btnVolOK");
const elSummary = document.getElementById("summary");
const canvasAcc = document.getElementById("accChart");
const elKeyboard = document.getElementById("keyboard");
const audioBufferCache = new Map(); // midi -> AudioBuffer
const VOLUME_CHECK_MIDI = 69; // A4(440Hz)相当のファイルがある前提。なければ変更
let inVolumeCheck = false;
let audioCtx = null;

function prettyLabel(s) {
  // 表示専用：解析には使わない
  return s.replace(/#/g, "♯");
}

// ====== UI生成 ======
function buildChoiceButtons() {
  const keyboard = document.getElementById("keyboard");
  if (!keyboard) {
    console.error('id="keyboard" が見つかりません');
    return;
  }
  keyboard.innerHTML = "";

  // 白鍵(7)と黒鍵(5)の配置（1オクターブ）
  const whiteKeys = ["C","D","E","F","G","A","B"];
  const blackKeys = [
    { note: "C#", leftBase: 0 }, // CとDの間
    { note: "D#", leftBase: 1 }, // DとEの間
    { note: "F#", leftBase: 3 }, // FとGの間
    { note: "G#", leftBase: 4 }, // GとAの間
    { note: "A#", leftBase: 5 }, // AとBの間
  ];

  const labelFor = (noteSharp) => {
    if (LABEL_MODE === "sharp") {
      return DISPLAY_LABELS[noteSharp] ?? noteSharp;
    }
    const idx = NOTE_NAMES.indexOf(noteSharp);
    return idx >= 0 ? SOLFEGE_NAMES[idx] : noteSharp;
  };

  const pressFlash = (btn) => {
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 120);
  };

  // 白鍵
  whiteKeys.forEach((note, i) => {
    const w = document.createElement("button");
    w.type = "button";
    w.className = "key white";
    w.style.left = `calc((100% / 7) * ${i})`;

    const span = document.createElement("span");
    span.className = "label";
    w.appendChild(span);
    span.textContent = prettyLabel(labelFor(note));
    w.addEventListener("click", () => {
      pressFlash(w);
      handleResponse(note); // 内部ラベルは C/D/E...
    });

    keyboard.appendChild(w);
  });

  // 黒鍵
  blackKeys.forEach(({ note, leftBase }) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "key black";

    // 黒鍵は白鍵の境目より少し右に置く
    // 0.70は見た目調整係数（好みで0.65〜0.75）
    b.style.left = `calc((100% / 7) * (${leftBase} + 0.70))`;

    const span = document.createElement("span");
    span.className = "label";
    span.textContent = labelFor(note);
    b.appendChild(span);

    b.addEventListener("click", () => {
      pressFlash(b);
      handleResponse(note); // 内部ラベルは C#...
    });

    keyboard.appendChild(b);
  });
}buildChoiceButtons();

// ====== MIDI -> note/oct & ファイル名 ======
function midiToPcOct(m) {
  const pcSharp = NOTE_NAMES[m % 12];          // 正誤判定の内部ラベル
  const solfege = SOLFEGE_NAMES[m % 12];       // 表示用（ドレミ）
  const pcFile  = LABEL_TO_FILE[pcSharp];      // 音ファイル名用
  const oct = Math.floor(m / 12) - 1;
  return { pc: pcSharp, solfege, pcFile, oct };
}

function midiToFilename(m) {
  const { pcFile, oct } = midiToPcOct(m);
  const num = String(m).padStart(3, "0");
  return `${num}-${pcFile}${oct}.wav`;
}

function filePathForMidi(m) {
  return `${AUDIO_DIR}/${midiToFilename(m)}`;
}

// ====== 音再生 ======
async function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state !== "running") await audioCtx.resume();
}

async function getAudioBuffer(m) {
  if (audioBufferCache.has(m)) return audioBufferCache.get(m);

  await ensureAudioCtx();
  const url = filePathForMidi(m);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`音ファイルが見つかりません: ${url}`);
  const buf = await res.arrayBuffer();
  const audioBuf = await audioCtx.decodeAudioData(buf);

  audioBufferCache.set(m, audioBuf);
  return audioBuf;
}

async function playMidi(m) {
  const audioBuf = await getAudioBuffer(m);

  const src = audioCtx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(audioCtx.destination);

  // 少し先に予約して再生（クリックノイズ/遅延ブレ軽減）
  const startAt = audioCtx.currentTime + 0.03;
  src.start(startAt);

  return startAt; // ★“音が鳴る予定の時刻”を返す
}

// ====== random化（MIDI範囲から試行を作る） ======
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function makeMidiPool() {
  const arr = [];
  for (let m = MIN_MIDI; m <= MAX_MIDI; m++) arr.push(m);
  return arr;
}


const MIN_INTERVAL = 13; // 制約固定：1オクターブ+半音

// ★ 60音(36..95)を全て1回ずつ使い、隣接差>=13を満たす順序を構成して返す
async function makeTrials(n) {
  const pool = makeMidiPool(); // 36..95
  if (n !== pool.length) {
    throw new Error(`これは「範囲の全音を1回ずつ」前提です。n=${n}, pool=${pool.length}`);
  }

  // 隣接可能性（グラフ）を事前計算
  const neighbors = new Map();
  for (const a of pool) {
    const nb = pool.filter(b =>
      b !== a &&
      Math.abs(b - a) >= MIN_INTERVAL &&
      (b % 12) !== (a % 12)          // ★追加：同じピッチクラス（オクターブ関係）禁止
    );
    neighbors.set(a, nb);
  }

  // 開始点：最も候補が少ない音から（端の音など）にすると成功しやすい
  const start = pool.slice().sort((x, y) => neighbors.get(x).length - neighbors.get(y).length)[0];

  // バックトラッキング（Warnsdorff的：次も“候補が少ない順”で試す）
  const used = new Set([start]);
  const path = [start];

  // ブラウザ固まり防止（一定回数ごとにyield）
  let steps = 0;
  const YIELD_EVERY = 3000;

  async function dfs(curr) {
    if (path.length === n) return true;

    steps++;
    if (steps % YIELD_EVERY === 0) {
      elStatus.textContent = `試行生成中… step=${steps} / length=${path.length}`;
      await new Promise(r => setTimeout(r, 0));
    }

    // 次候補：未使用かつ制約OK
    const cand = neighbors.get(curr).filter(v => !used.has(v));

    // ヒューリスティック：次の候補数（未使用近傍数）が少ない順に試す
    cand.sort((a, b) => {
      const da = neighbors.get(a).filter(v => !used.has(v)).length;
      const db = neighbors.get(b).filter(v => !used.has(v)).length;
      return da - db;
    });

    // 少しランダム性を足したい場合（同点の並び替え）
    // ただし“制約は固定”のまま
    // shuffle(cand);

    for (const nxt of cand) {
      used.add(nxt);
      path.push(nxt);

      if (await dfs(nxt)) return true;

      path.pop();
      used.delete(nxt);
    }
    return false;
  }

  const ok = await dfs(start);
  if (!ok) {
    throw new Error("解が見つかりませんでした（ただし理論上は解があるはずなので、範囲/ファイル欠損なども確認してください）");
  }

  // trials化
  return path.map((m) => {
    const { pc, oct } = midiToPcOct(m);
    return { midi: m, target: pc, oct, file: midiToFilename(m) };
  });
}

// ====== 課題進行 ======
async function startTask() {
    subjID = (elSubjId.value || "").trim();
    if (!subjID) {
      elStatus.textContent = "Please enter the Subject ID or Name.";
      return;
    }
  
    // UI固定
    btnDownload.disabled = true;
    btnStart.disabled = true;
    elSubjId.disabled = true;
  
    // ここから音量チェック
    inVolumeCheck = true;
    btnVolPlay.disabled = false;
    btnVolOK.disabled = false;
  
    elStatus.textContent = "Volume Check: Adjust to a comfortable listening level.";
  }


  let trialTimeoutId = null;
  let respondedThisTrial = false;
  
  async function nextTrial() {
    // 前のタイマーが残ってたら消す
    if (trialTimeoutId) {
      clearTimeout(trialTimeoutId);
      trialTimeoutId = null;
    }
  
    trialIndex++;
    if (trialIndex >= trials.length) {
      finishTask();
      return;
    }
  
    current = trials[trialIndex];
    respondedThisTrial = false;
    canRespond = false;
  
    elStatus.textContent = `Trial ${trialIndex + 1} / ${trials.length}：Now playing...`;
  
    try {
      elStatus.textContent = `Trial ${trialIndex + 1} / ${trials.length}：Loading...`;
    
      const startAt = await playMidi(current.midi);
    
      // “予約したstartAt”をperformance.now()に換算（厳密ではないが十分安定）
      const nowCtx = audioCtx.currentTime;
      const msUntilStart = Math.max(0, (startAt - nowCtx) * 1000);
    
      canRespond = true;
    
      // 表示は「音が鳴る直前〜直後」に合わせる
      setTimeout(() => {
        tSoundOn = performance.now();
        elStatus.textContent = `Trial ${trialIndex + 1} / ${trials.length}：Answer now (5 seconds).`;
      }, msUntilStart);
    
      // ★重要：次のtrialへは「音開始から5秒」で固定
      trialTimeoutId = setTimeout(() => {
        if (!respondedThisTrial) {
          results.push({
            subjID,
            trial: trialIndex + 1,
            midi: current.midi,
            file: current.file,
            target: current.target,
            target_solfege: midiToPcOct(current.midi).solfege,
            response: "",
            response_solfege: "",
            correct: 0,
            rt_ms: "",
            no_response: 1
          });
        }
        canRespond = false;
        nextTrial();
      }, msUntilStart + TRIAL_MS);
    
    } catch (e) {
      elStatus.textContent = String(e.message || e);
      btnStart.disabled = false;
      elSubjId.disabled = false;
      return;
    }
  
    // ★ここが重要：trial開始から5秒後に必ず次へ（回答の有無に関係なし）
    const elapsed = performance.now() - trialStartPerf;
    const remain = Math.max(0, TRIAL_MS - elapsed);
  
    trialTimeoutId = setTimeout(() => {
      // 無回答なら無回答行を記録してから次へ
      if (!respondedThisTrial) {
        results.push({
          subjID,
          trial: trialIndex + 1,
          midi: current.midi,
          file: current.file,
          target: current.target,
          target_solfege: midiToPcOct(current.midi).solfege,
          response: "",
          response_solfege: "",
          correct: 0,
          rt_ms: "",
          no_response: 1
        });
      }
      canRespond = false;
      nextTrial();
    }, remain);
  }

  function handleResponse(resp) {
    if (!canRespond || !current) return;
    if (respondedThisTrial) return; // 1trial 1回答
  
    const rt = performance.now() - tSoundOn;
    const correct = resp === current.target;
  
    const responseIdx = NOTE_NAMES.indexOf(resp);
    const responseSolfege = responseIdx >= 0 ? SOLFEGE_NAMES[responseIdx] : "";
  
    results.push({
      subjID,
      trial: trialIndex + 1,
      midi: current.midi,
      file: current.file,
      target: current.target,
      target_solfege: midiToPcOct(current.midi).solfege,
      response: resp,
      response_solfege: responseSolfege,
      correct: correct ? 1 : 0,
      rt_ms: Math.round(rt),
      no_response: 0
    });
  
    respondedThisTrial = true;
  
    // ★すぐ次へ行かない：trialTimeoutが5秒後に進める
    elStatus.textContent = `Recorded. Waiting for the next sound...`;
  }


function finishTask() {
  const { nCorrect, total } = calcAccuracy();
  const accText = `${nCorrect} / ${total}`;
  
  elStatus.innerHTML = `
    <b>You're done!</b><br>
    Correct answers：<b>${accText}</b><br>
    Accuracy rate：<b>${Math.round((nCorrect / total) * 100)}%</b><br>
    Please click Download CSV.
    `;
  
    btnDownload.disabled = false;
    btnStart.disabled = false;
    elSubjId.disabled = false;

    // --- 音階音ごとの正答率グラフ ---
    const { labels, rates, totals } = calcAccuracyByPitchClass();
    canvasAcc.style.display = "block";
    drawBarChartAccuracy(canvasAcc, labels, rates, totals);
  
    // 画面リサイズで再描画（1回だけ設定）
    window.onresize = () => drawBarChartAccuracy(canvasAcc, labels, rates, totals);
  
}

function calcAccuracy() {
  const nCorrect = results.filter(r => r.correct === 1).length;
  const total = N_TRIALS;
  return { nCorrect, total };
}

function calcAccuracyByPitchClass() {
  // 12音の集計：targetごとに (correct数 / 出題数)
  const stat = {};
  NOTE_NAMES.forEach(n => stat[n] = { total: 0, correct: 0 });

  for (const r of results) {
    // trialが数値の行だけ（summary等が混ざっても無視できる）
    if (typeof r.trial !== "number") continue;
    if (!r.target || !(r.target in stat)) continue;

    stat[r.target].total += 1;
    if (r.correct === 1) stat[r.target].correct += 1;
  }

  const labels = NOTE_NAMES.slice();
  const rates = labels.map(n => {
    const { total, correct } = stat[n];
    return total ? (correct / total) : 0;
  });
  const totals = labels.map(n => stat[n].total);
  return { labels, rates, totals };
}

function labelForDisplay(pcSharp) {
  if (LABEL_MODE === "sharp") return pcSharp;
  const idx = NOTE_NAMES.indexOf(pcSharp);
  return idx >= 0 ? SOLFEGE_NAMES[idx] : pcSharp;
}

function drawBarChartAccuracy(canvas, labelsSharp, rates, totals) {
  // ★ 鍵盤の幅に揃える
  const cssW = elKeyboard.getBoundingClientRect().width;
  const cssH = 220;

  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, cssW, cssH);

  // 余白
  const padL = 40, padR = 10, padT = 10, padB = 40;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  // 軸（0〜100%）
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();

  // 目盛（0,50,100）
  ctx.fillStyle = "#333";
  ctx.font = "12px system-ui, sans-serif";
  [0, 0.5, 1].forEach(v => {
    const y = padT + plotH - v * plotH;
    ctx.strokeStyle = "#ddd";
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();

    ctx.fillStyle = "#333";
    ctx.fillText(`${Math.round(v*100)}%`, 4, y + 4);
  });

  // Bar
  const n = labelsSharp.length;
  const gap = 6;
  const barW = Math.max(6, (plotW - gap * (n - 1)) / n);

  ctx.fillStyle = "#4a78ff"; // ※色指定を避けたいならここを消して黒でもOK
  ctx.strokeStyle = "#333";

  for (let i = 0; i < n; i++) {
    const rate = rates[i];          // 0..1
    const x = padL + i * (barW + gap);
    const h = rate * plotH;
    const y = padT + plotH - h;

    const pc = labelsSharp[i];
    const black = pc.includes("#");

    ctx.fillStyle = black ? "#888" : "#fff";
    ctx.strokeStyle = "#333";

    ctx.fillRect(x, y, barW, h);
    ctx.strokeRect(x, y, barW, h);

    // xラベル（表示モードに合わせる）
    const lab = prettyLabel(labelForDisplay(labelsSharp[i]));
    ctx.save();
    ctx.translate(x + barW / 2, padT + plotH + 14);
    ctx.rotate(-Math.PI / 6); // 少し斜め
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#333";
    ctx.fillText(lab, 0, 0);
    ctx.restore();

    // 出題数（小さく）
    ctx.fillStyle = "#333";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText(`n=${totals[i]}`, x + 1, padT + plotH + 32);
    ctx.font = "12px system-ui, sans-serif";
  }
}

async function volumePlay() {
    try {
      await playMidi(VOLUME_CHECK_MIDI);
    } catch (e) {
      elStatus.textContent = String(e.message || e);
    }
  }
  
  async function volumeOK() {
    if (!inVolumeCheck) return;
  
    inVolumeCheck = false;
    btnVolPlay.disabled = true;
    btnVolOK.disabled = true;
  
    results = [];
    elStatus.textContent = "Generating trials...";
  
    try {
      trials = await makeTrials(N_TRIALS);  // ★ここ
    } catch (e) {
      elStatus.textContent = `Generation Error：${e.message}`;
      // ボタンを戻して再試行できるように
      btnVolPlay.disabled = false;
      btnVolOK.disabled = false;
      inVolumeCheck = true;
      return;
    }
  
    trialIndex = -1;
    elStatus.textContent = `The main trial will begin in 5 seconds...`;
  
    setTimeout(async () => {
      elStatus.textContent = "The trial begins";
      await nextTrial();
    }, START_DELAY_MS);
  }

// ====== CSV出力 ======
function toCSV(rows) {
  const header = Object.keys(rows[0] || {});
  const esc = (v) => {
    const s = String(v ?? "");
    return /[,"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [header.join(",")].concat(rows.map(r => header.map(h => esc(r[h])).join(",")));
  return lines.join("\n");
}

function downloadCSV() {
  if (!results.length) return;

  // 正答率を計算
  const nCorrect = results.filter(r => r.correct === 1).length;
  const total = N_TRIALS;
  const accPercent = Math.round((nCorrect / total) * 100);

  const csv = toCSV(results);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");

  const timestamp = new Date()
    .toISOString()
    .slice(0,19)
    .replaceAll(":","-");

  // ★ 正答率％をファイル名に入れる
  a.download = `ap_${subjID}_acc${accPercent}pct_${timestamp}.csv`;

  a.href = URL.createObjectURL(blob);
  a.click();
  URL.revokeObjectURL(a.href);
}

btnStart.addEventListener("click", startTask);
btnDownload.addEventListener("click", downloadCSV);
btnVolPlay.addEventListener("click", volumePlay);
btnVolOK.addEventListener("click", volumeOK);