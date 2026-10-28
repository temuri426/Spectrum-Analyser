/* Wi-Spy DBx3 — RF Interference Analyzer (frontend v7.1.0)
 * Complete rendering implementation: live spectrum, waterfall, event table,
 * source hunt with level history, and 2.4 GHz / 5 GHz live band switching.
 */
const S = document.getElementById("spectrum"),
      W = document.getElementById("waterfall"),
      H = document.getElementById("history");
const sx = S.getContext("2d"), wx = W.getContext("2d"), hx = H.getContext("2d");

let target = null, selectedKey = null, events = [], signalHistory = [],
    lastFrame = null, allFrames = [];
let freqRange = "2.4GHz";
const F0_24 = 2400, F1_24 = 2495, F0_5G = 5150, F1_5G = 5825;
const MIN_DBM = -120, MAX_DBM = -40;
/* Waterfall gets its own contrast window (Chanalyzer Pro-style):
   noise floor renders as visible dark blue instead of near-black. */
const WMIN_DBM = -125, WMAX_DBM = -55;
let currentRange = { f0: F0_24, f1: F1_24, label: "2.4GHz" };
let initialized = false;
let wfCache = null;
/* --- waterfall frame stacking ---
   wfHistory keeps every frame we receive (newest last) so the waterfall can be
   rebuilt for any time window instead of only the last screenful of rows.
   wfWindow = window length in seconds; 0 => "Live" (unstacked rolling rows). */
let wfHistory = [], wfWindow = 600, wfLastTs = 0, sinceTs = 0;
const WF_MAX_AGE = 3600;            /* never retain more than 1 h in the browser */

/* ---------------- colour palette ---------------- */
function hsl2rgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s,
        x = c * (1 - Math.abs((h * 6) % 2 - 1)),
        m = l - c / 2;
  let r, g, b, hh = h * 6;
  if (hh < 1) { r = c; g = x; b = 0; }
  else if (hh < 2) { r = x; g = c; b = 0; }
  else if (hh < 3) { r = 0; g = c; b = x; }
  else if (hh < 4) { r = 0; g = x; b = c; }
  else if (hh < 5) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
/* Chanalyzer Pro-style waterfall gradient:
   black noise floor -> deep blue -> blue -> cyan -> green -> yellow -> orange -> red -> white */
const PALETTE = (() => {
  const stops = [
    [0.00, [8, 10, 42]],
    [0.08, [4, 4, 48]],
    [0.20, [8, 28, 130]],
    [0.34, [10, 110, 210]],
    [0.46, [0, 190, 220]],
    [0.58, [30, 200, 130]],
    [0.68, [120, 205, 40]],
    [0.78, [235, 200, 0]],
    [0.87, [245, 130, 0]],
    [0.94, [225, 40, 20]],
    [1.00, [255, 245, 235]],
  ];
  const p = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const t0 = stops[k][0], c0 = stops[k][1];
    const t1 = stops[k + 1][0], c1 = stops[k + 1][1];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    p[i * 3]     = Math.round(c0[0] + (c1[0] - c0[0]) * f);
    p[i * 3 + 1] = Math.round(c0[1] + (c1[1] - c0[1]) * f);
    p[i * 3 + 2] = Math.round(c0[2] + (c1[2] - c0[2]) * f);
  }
  return p;
})();
function heat(v) {
  let t = (v - MIN_DBM) / (MAX_DBM - MIN_DBM);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const i = Math.round(t * 255);
  return "rgb(" + PALETTE[i * 3] + "," + PALETTE[i * 3 + 1] + "," + PALETTE[i * 3 + 2] + ")";
}

/* ---------------- canvas sizing ---------------- */
function fit(c) {
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  const w = Math.round(r.width), h = Math.round(r.height);
  if (w < 2 || h < 2) return { w: 0, h: 0, ctx: c.getContext("2d") };
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, ctx };
}
function X(f, w) {
  return (f - currentRange.f0) / (currentRange.f1 - currentRange.f0) * w;
}

/* ---------------- spectrum ---------------- */
function drawSpectrum(f) {
  const { w, h, ctx } = fit(S);
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  const pad = 42, ph = h - pad;

  ctx.strokeStyle = "#183344";
  ctx.fillStyle = "#7894a8";
  ctx.font = "10px Arial";
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const x = w * i / ticks;
    const freq = currentRange.f0 + (currentRange.f1 - currentRange.f0) * i / ticks;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke();
    const lbl = freq.toFixed(0) + " MHz";
    ctx.fillText(lbl, Math.min(w - 58, x + 2), h - 27);
  }
  for (let i = 1; i < 4; i++) {
    const y = ph * i / 4;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  if (currentRange.label === "2.4GHz") {
    [[2412, 1], [2437, 6], [2462, 11]].forEach(([cf, ch]) => {
      const x = X(cf, w);
      ctx.strokeStyle = "#16ed88";
      ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#16ed88";
      ctx.font = "bold 11px Arial";
      const lab = "CH " + ch, tw = ctx.measureText(lab).width;
      ctx.fillText(lab, Math.max(2, Math.min(w - tw - 2, x - tw / 2)), h - 11);
    });
  }

  if (target) {
    const xa = X(Number(target.start), w), xb = X(Number(target.end), w);
    ctx.fillStyle = "rgba(255,202,40,.12)";
    ctx.fillRect(xa, 0, Math.max(2, xb - xa), ph);
    ctx.strokeStyle = "#ffca28";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xa, 0); ctx.lineTo(xa, ph);
    ctx.moveTo(xb, 0); ctx.lineTo(xb, ph);
    ctx.stroke();
  }

  if (!f || !f.values || !f.values.length) {
    ctx.fillStyle = "#829caf";
    ctx.font = "13px Arial";
    ctx.fillText("Waiting for spectrum data…", 12, 24);
    return;
  }

  const vals = f.values, n = vals.length;
  const xAt = i => (n <= 1 ? 0 : i / (n - 1) * w);
  const yAt = v => ph - (Math.max(MIN_DBM, Math.min(MAX_DBM, v)) - MIN_DBM) / (MAX_DBM - MIN_DBM) * ph;

  ctx.beginPath();
  ctx.moveTo(0, ph);
  for (let i = 0; i < n; i++) ctx.lineTo(xAt(i), yAt(vals[i]));
  ctx.lineTo(w, ph);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, ph);
  g.addColorStop(0, "rgba(63,185,80,.55)");
  g.addColorStop(1, "rgba(63,185,80,.04)");
  ctx.fillStyle = g;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xAt(i), y = yAt(vals[i]);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = "#3fb950";
  ctx.lineWidth = 1.2;
  ctx.stroke();

  let pk = -Infinity, pki = 0;
  for (let i = 0; i < n; i++) if (vals[i] > pk) { pk = vals[i]; pki = i; }
  if (Number.isFinite(pk)) {
    ctx.fillStyle = "#ffca28";
    ctx.beginPath(); ctx.arc(xAt(pki), yAt(pk), 3, 0, Math.PI * 2); ctx.fill();
  }
}

/* ---------------- waterfall ---------------- */
/* Paints one row of pixels from a frame's bin values. */
function paintRow(d, y, w, vals, vlen) {
  for (let x = 0; x < w; x++) {
    const vi = Math.min(vlen - 1, Math.floor(x * vlen / w));
    let t = (vals[vi] - WMIN_DBM) / (WMAX_DBM - WMIN_DBM);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const pi = Math.round(t * 255), o = (y * w + x) * 4;
    d[o] = PALETTE[pi * 3];
    d[o + 1] = PALETTE[pi * 3 + 1];
    d[o + 2] = PALETTE[pi * 3 + 2];
    d[o + 3] = 255;
  }
}

/* Stacked mode: bucket retained frames by time and keep the per-bin maximum
   (max-hold) so short bursts stay visible instead of vanishing between rows. */
function drawStacked(d, w, h) {
  const T = wfHistory[wfHistory.length - 1].ts;
  const step = wfWindow / h;                 /* seconds per row */
  const rows = new Array(h);
  for (let i = 0; i < wfHistory.length; i++) {
    const f = wfHistory[i], vals = f.values, vlen = vals.length;
    const age = T - f.ts;
    if (age < 0 || age > wfWindow) continue;
    let y = Math.floor(age / step);
    if (y < 0) y = 0; else if (y >= h) y = h - 1;
    let row = rows[y];
    if (!row) {
      row = rows[y] = new Float32Array(w);
      for (let x = 0; x < w; x++)
        row[x] = vals[Math.min(vlen - 1, Math.floor(x * vlen / w))];
    } else {
      for (let x = 0; x < w; x++) {
        const v = vals[Math.min(vlen - 1, Math.floor(x * vlen / w))];
        if (v > row[x]) row[x] = v;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    if (!row) {                              /* empty time bucket = gap */
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        d[o] = 8; d[o + 1] = 12; d[o + 2] = 22; d[o + 3] = 255;
      }
      continue;
    }
    paintRow(d, y, w, row, w);
  }
}

function fmtAge(s) {
  if (s >= 3600) return "−" + Math.round(s / 3600) + "h";
  if (s >= 60) return "−" + Math.round(s / 60) + "m";
  return "−" + Math.round(s) + "s";
}

function drawWaterfall(fs) {
  const { w, h, ctx } = fit(W);
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);

  if (!fs || !fs.length) {
    ctx.fillStyle = "#829caf";
    ctx.font = "13px Arial";
    ctx.fillText("Waiting for waterfall data…", 12, 24);
    return;
  }

  if (!wfCache || wfCache.w !== w || wfCache.h !== h)
    wfCache = { w, h, img: ctx.createImageData(w, h) };
  const img = wfCache.img, d = img.data;
  d.fill(0);

  const stacked = wfWindow > 0 && wfHistory.length > 1;
  if (stacked) {
    drawStacked(d, w, h);
  } else {
    const n = Math.min(fs.length, h);
    for (let y = 0; y < n; y++) {
      const f = fs[fs.length - 1 - y];      /* newest row at top */
      paintRow(d, y, w, f.values, f.values.length);
    }
  }
  ctx.putImageData(img, 0, 0);

  if (stacked) {                            /* time axis: now top -> oldest bottom */
    const step = wfWindow / h;
    ctx.font = "10px Arial";
    ctx.textAlign = "left";
    for (let k = 1; k <= 4; k++) {
      const secs = wfWindow * k / 4, y = Math.round(secs / step);
      if (y >= h - 2) continue;
      const lbl = fmtAge(secs);
      ctx.fillStyle = "rgba(6,12,20,.75)";
      ctx.fillRect(4, y - 11, ctx.measureText(lbl).width + 8, 13);
      ctx.fillStyle = "rgba(180,215,235,.9)";
      ctx.fillText(lbl, 8, y);
    }
    ctx.textAlign = "start";
  }
}

/* ---------------- history ---------------- */
function drawHistory() {
  const { w, h, ctx } = fit(H);
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#183344";
  ctx.beginPath(); ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1); ctx.stroke();

  if (signalHistory.length < 2) {
    ctx.fillStyle = "#829caf";
    ctx.font = "12px Arial";
    ctx.fillText("Select an interference event to see level history", 12, 22);
    return;
  }
  const vals = signalHistory.slice(-240);
  let mn = Infinity, mx = -Infinity;
  for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const rng = Math.max(1, mx - mn);
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = i / (vals.length - 1) * w;
    const y = h - 8 - ((v - mn) / rng) * (h - 20);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = "#ffca28";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/* ---------------- level in target band ---------------- */
function level(f) {
  if (!target || !f || !Array.isArray(f.values) || !f.values.length) return null;
  const step = (currentRange.f1 - currentRange.f0) / Math.max(1, f.values.length - 1);
  let a = Math.max(0, Math.floor((Number(target.start) - currentRange.f0) / step));
  let b = Math.min(f.values.length - 1, Math.ceil((Number(target.end) - currentRange.f0) / step));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b < a) {
    const c = Math.round((Number(target.center) - currentRange.f0) / step);
    a = b = Math.max(0, Math.min(f.values.length - 1, c));
  }
  let pk = -Infinity;
  for (let i = a; i <= b; i++) {
    const v = Number(f.values[i]);
    if (Number.isFinite(v) && v > pk) pk = v;
  }
  return Number.isFinite(pk) ? Math.round(pk * 10) / 10 : null;
}

/* ---------------- UI helpers ---------------- */
function updateRangeUI(label) {
  const is5 = label === "5GHz";
  const live = document.getElementById("live");
  if (live && live.nextElementSibling)
    live.nextElementSibling.textContent = is5
      ? "5 GHz · 5150–5825 MHz · 285 samples"
      : "2.4 GHz · 2400–2495 MHz · 285 samples";
  const fd = document.getElementById("freq-display");
  if (fd) fd.textContent = is5
      ? "5 GHz · 5150–5825 MHz · RBW 333 kHz"
      : "2.4 GHz · 2400–2495 MHz · RBW 333 kHz";
  const rl = document.getElementById("spectrum-range-label");
  if (rl) rl.textContent = is5 ? "(5 GHz)" : "(2.4 GHz)";
  const b24 = document.getElementById("btn24"), b5 = document.getElementById("btn5");
  if (b24) b24.classList.toggle("active", !is5);
  if (b5) b5.classList.toggle("active", is5);
}

function syncRangeFromStatus(st) {
  const label = (st && st.active_label) || "2.4GHz";
  freqRange = label;
  currentRange = label === "5GHz"
    ? { f0: F0_5G, f1: F1_5G, label: "5GHz" }
    : { f0: F0_24, f1: F1_24, label: "2.4GHz" };
  updateRangeUI(label);
}

async function setFrequencyRange(label) {
  freqRange = label;
  currentRange = label === "5GHz"
    ? { f0: F0_5G, f1: F1_5G, label: "5GHz" }
    : { f0: F0_24, f1: F1_24, label: "2.4GHz" };
  updateRangeUI(label);
  clearTarget();
  allFrames = []; lastFrame = null; events = []; signalHistory = []; wfHistory = []; sinceTs = 0;
  drawSpectrum(null);
  drawWaterfall([]);
  const st = document.getElementById("status");
  if (st) st.textContent = "switching to " + label + "…";
  try {
    const r = await fetch("/api/range?r=" + encodeURIComponent(label));
    const j = await r.json();
    if (st) st.textContent = "switched to " + (j.range || label);
  } catch (e) {
    if (st) st.textContent = "switch failed: " + e.message;
  }
}

function setWfWindow(v) {
  wfWindow = Number(v) || 0;
  wfHistory = wfWindow > 0 ? allFrames.slice() : [];
  drawWaterfall(allFrames);
}

function selectTarget(e) {
  target = e; selectedKey = e.center;
  const empty = document.getElementById("empty"),
        hunt = document.getElementById("hunt"),
        badge = document.getElementById("badge");
  if (empty) empty.style.display = "none";
  if (hunt) hunt.style.display = "block";
  if (badge) { badge.classList.add("on"); badge.textContent = "Active"; }
  document.getElementById("tf").textContent = e.center.toFixed(2) + " MHz";
  document.getElementById("tt").textContent = e.likely || e.pattern || "Unknown RF";
  document.getElementById("tp").textContent = e.peak + " dBm";
  document.getElementById("tb").textContent = e.bw.toFixed(2) + " MHz";
  document.getElementById("td").textContent = e.duty + "%";
  document.getElementById("tc").textContent = e.center.toFixed(2) + " MHz";
  signalHistory = [];
  drawHistory();
}

function clearTarget() {
  target = null; selectedKey = null; signalHistory = [];
  const empty = document.getElementById("empty"),
        hunt = document.getElementById("hunt"),
        badge = document.getElementById("badge");
  if (empty) empty.style.display = "block";
  if (hunt) hunt.style.display = "none";
  if (badge) { badge.classList.remove("on"); badge.textContent = "Inactive"; }
  drawHistory();
}

function renderEvents(list) {
  const box = document.getElementById("events");
  if (!box) return;
  box.innerHTML = "";
  (list || []).forEach(e => {
    const row = document.createElement("div");
    row.className = "event" + (selectedKey === e.center ? " selected" : "");
    row.innerHTML =
      '<div class="dot" style="background:' + heat(e.peak) + '"></div>' +
      '<div class="freq">' + e.center.toFixed(2) + ' MHz</div>' +
      '<div>' + e.bw.toFixed(2) + ' MHz</div>' +
      '<div>' + e.peak + ' dBm</div>' +
      '<div>' + e.duty + '%</div>' +
      '<div class="tag">' + (e.likely || e.pattern || 'Unknown') + '</div>';
    row.onclick = () => selectTarget(e);
    box.appendChild(row);
  });
}

/* ---------------- polling ---------------- */
async function tick() {
  try {
    const qs = sinceTs > 0 ? "?since=" + sinceTs : "";
    const [frRes, stRes] = await Promise.all([fetch("/api/frames" + qs), fetch("/api/status")]);
    const fr = await frRes.json();
    const st = await stRes.json();
    if (sinceTs === 0) {
      allFrames = Array.isArray(fr) ? fr : [];    /* first load: server ring buffer */
    } else if (Array.isArray(fr) && fr.length) {
      allFrames = allFrames.concat(fr);          /* append only the new frames */
      const keep = wfWindow > 0 ? wfWindow : 900; /* seconds of history to retain */
      const newest = allFrames[allFrames.length - 1].ts;
      if (allFrames[0].ts < newest - keep)
        allFrames = allFrames.filter(f => f.ts >= newest - keep);
    }
    /* empty incremental response => keep existing history (never blank the UI) */
    if (allFrames.length) sinceTs = allFrames[allFrames.length - 1].ts;
    lastFrame = allFrames.length ? allFrames[allFrames.length - 1] : null;
    if (wfWindow > 0) wfHistory = allFrames;     /* server keeps WISPY_HISTORY frames (~20 min) */
    if (!initialized) { initialized = true; syncRangeFromStatus(st); }

    drawSpectrum(lastFrame);
    drawWaterfall(allFrames);

    if (target && lastFrame) {
      const lv = level(lastFrame);
      if (lv !== null) {
        document.getElementById("tl").textContent = lv + " dBm";
        const now = document.getElementById("now");
        if (now) now.textContent = "Current: " + lv + " dBm";
        const bar = document.getElementById("bar");
        if (bar) bar.style.width = Math.max(0, Math.min(100, ((lv + 120) / 80) * 100)) + "%";
        signalHistory.push(lv);
        if (signalHistory.length > 300) signalHistory.shift();
        drawHistory();
      }
    }

    document.getElementById("mp").textContent = lastFrame ? lastFrame.peak + " dBm" : "—";
    document.getElementById("mn").textContent = lastFrame ? lastFrame.base + " dBm" : "—";
    document.getElementById("mb").textContent = lastFrame ? lastFrame.active_bw + " MHz" : "—";
    document.getElementById("status").textContent = "connected · " + st.frames + " frames · " + st.active_label;
  } catch (e) {
    const st = document.getElementById("status");
    if (st) st.textContent = "disconnected (" + e.message + ")";
  }
}

async function tickEvents() {
  try {
    const r = await fetch("/api/events");
    const ev = await r.json();
    events = ev.events || [];
    document.getElementById("me").textContent = events.length;
    renderEvents(events);
  } catch (e) {}
}

/* ---------------- boot ---------------- */
window.addEventListener("resize", () => {
  drawSpectrum(lastFrame);
  drawWaterfall(allFrames);
  drawHistory();
});
const _wfsel = document.getElementById("wfwin");
if (_wfsel) setWfWindow(_wfsel.value);
tick();
tickEvents();
setInterval(tick, 500);
setInterval(tickEvents, 2000);
