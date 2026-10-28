# Wi-Spy DBx3 — RF Interference Analyzer (v7.0.0)

A lightweight, browser-based spectrum analyzer for the **Wi-Spy DBx3** USB spectrum
analyzer. A single Python file (`server.py`) drives the hardware through the
`spectool_raw` collector, analyzes every sweep server-side, and serves a live
web dashboard (spectrum, waterfall, signal-level history, interference events) on port
8080. No cloud service, no pip dependencies, no build step — Python 3 standard
library only.

The dashboard supports **2.4 GHz and 5 GHz** bands, switchable at runtime without
restarting the server or reloading the page.

---

## 1. Hardware requirements

| Item | Requirement |
|---|---|
| Spectrum analyzer | **Wi-Spy DBx3** (USB). Verified device ID: `Wi-Spy DBx3 USB 0 id 5` |
| Host | Any Linux machine with USB access — **tested on a Raspberry Pi** (see §2) |
| Antenna | The antenna supplied with the DBx3 (SMA). Screw it on before scanning. |
| USB port | USB 2.0 or better, direct or via a powered hub |

The DBx3 exposes six hardware ranges (from `spectool_raw -l`):

| Range | Name | Coverage | Resolution | Samples |
|---|---|---|---|---|
| 0 | Full 2.4 GHz Band | 2400–2495 MHz | 333 kHz | 285 |
| 1 | Full 2.4 GHz Band (Turbo) | 2400–2495 MHz | 1 MHz | 95 |
| 2 | Full 5 GHz Band | 5150–5836 MHz | 1.5 MHz | 458 |
| 3 | UNII Low/Mid (ch. 36–64) | 5150–5350 MHz | 748 kHz | 267 |
| 4 | UNII Low/Mid (ch. 100–140) | 5470–5725 MHz | 1.12 MHz | 227 |
| 5 | UNII Low/Mid (ch. 149–165) | 5725–5836 MHz | 375 kHz | 296 |

This app uses **range 0** for 2.4 GHz and **range 2** for 5 GHz. The narrower UNII
ranges (3–5) can be used by editing the range strings in `server.py` if you want a
zoomed 5 GHz view.

> Other Wi-Spy models supported by `spectools` (DBx, DBi, 2.4x, 2.4i) may work, but
> the range indices and analysis thresholds in this build are tuned for the DBx3.
> Check what your device reports with `spectool_raw -l` before changing ranges.

---

## 2. Tested environment

Verified working on a Raspberry Pi running Debian 13 (trixie):

| Component | Version / value |
|---|---|
| Hardware | Raspberry Pi (hostname `Pi`) |
| OS | **Debian GNU/Linux 13 (trixie)**, `VERSION_ID="13"`, `DEBIAN_VERSION_FULL=13.3` |
| Kernel | `6.12.62+rpt-rpi-v8 #1 SMP PREEMPT ... aarch64` |
| Python | `3.13.5` (standard library only) |
| `spectools` package | `201601r1-6` (arm64) |
| Collector binary | `/usr/bin/spectool_raw` |
| Network | Reached from a Windows PC over LAN at `http://192.168.7.129:8080` |

Equivalent Debian/Ubuntu or Raspberry Pi OS (Bullseye/Bookworm/Trixie) installs
should work unchanged; the only hard requirement is the `spectools` package and a
USB port the Pi can power.

---

## 3. Installation

### 3.1 Install the collector

```bash
sudo apt update
sudo apt install -y spectools python3
```

`spectools` provides `spectool_raw`, the CLI that streams raw sweep data from the
USB device. It must be on `PATH` (normally `/usr/bin/spectool_raw`).

### 3.2 Plug in the DBx3 and verify

```bash
spectool_raw -l
```

Expected output:

```
Found 1 devices...
Device 0: Wi-Spy DBx3 USB 0 id 5
  Range 0: "Full 2.4GHz Band" 2400MHz-2495MHz @ 333.00KHz, 285 samples
  ...
```

If you see "No devices found":

- Re-seat the USB cable and confirm the device LED is lit.
- Check `lsusb | grep -i wi-spy` — it should appear as a Cypress/ViSPY device.
- USB permissions: run once with `sudo`, or add a udev rule for your user.

### 3.3 Deploy the app

```bash
# from wherever you copied this folder
cd ~/wispy7.0
chmod +x server.py start.sh
```

No `pip install` step is required — `server.py` imports only the standard library
(`http.server`, `subprocess`, `threading`, `collections`, `json`, …).

---

## 4. Running the app

### Foreground (quick test)

```bash
sudo python3 server.py
```

You should see:

```
Wi-Spy analyzer v7: http://0.0.0.0:8080 range=2.4GHz
```

Then open `http://<host-ip>:8080/` in a browser (e.g. `http://192.168.7.129:8080`).

### Launcher script

```bash
./start.sh
```

`start.sh` is just `cd` to its own directory and `exec python3 server.py`, so it
works from any working directory and keeps relative `static/` paths valid.

### Background / boot-time (systemd)

```ini
# /etc/systemd/system/wispy-analyzer.service
[Unit]
Description=Wi-Spy DBx3 RF Interference Analyzer
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/pi/wispy7.0
Environment=WISPY_RANGE=0:0
Environment=WISPY_PORT=8080
ExecStart=/usr/bin/python3 server.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wispy-analyzer
sudo journalctl -u wispy-analyzer -f     # logs
```

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `WISPY_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to restrict to localhost. |
| `WISPY_PORT` | `8080` | HTTP port. |
| `WISPY_RANGE` | `0:0` | Startup band as `DEVICE:RANGE_INDEX`. `0:0` = 2.4 GHz, `0:2` = 5 GHz. Legacy MHz-style values (`5150:5825`) are also accepted. |
| `WISPY_HISTORY` | `1500` | Frames kept in the in-memory ring buffer. At 1 frame/sec this is ~25 min. |

Examples:

```bash
# 5 GHz from the start, on port 8090, keeping 45 minutes of history
WISPY_RANGE=0:2 WISPY_PORT=8090 WISPY_HISTORY=2700 sudo -E python3 server.py
```

> **sudo note:** `spectool_raw` needs raw USB access. If your user is in the
> `plugdev` group with a proper udev rule, plain `python3 server.py` works; otherwise
> run under `sudo` and pass env vars through with `sudo -E`.

---

## 5. Using the dashboard

Open `http://<host>:8080/`.

| UI element | What it does |
|---|---|
| **2.4 GHz / 5 GHz buttons** | Switch band live. The server retunes the device, clears the frame buffer so the two bands never mix, and the active button is highlighted. |
| **Live Spectrum** | Current sweep: power vs frequency (dBm), with Wi-Fi channel numbers under the frequency axis. The selected interference region is outlined in yellow. |
| **Waterfall** (subtitle "time history") | Frames stacked by age; brighter/yellower = stronger signal. Reveals burst periodicity and hopping patterns. Selected interference is outlined in yellow across the whole waterfall. |
| **Waterfall window dropdown** | `Live rolling` (unstacked), `Keep 1 / 5 / 10 / 30 min`. Default **10 min**. |
| **Source Hunt** | Shows `Inactive` until you pick an event. Then displays the target frequency, a live level meter (higher/less negative dBm = closer to the source), and PEAK / BANDWIDTH / DUTY CYCLE / CENTER FREQ stats. |
| **Detected RF Interference** | Table of detected events: frequency, bandwidth, peak, duty cycle and type. Click a row to select it (yellow border) — this activates Source Hunt and Signal Level History. |
| **Signal Level History** | Inside Source Hunt. Once an event is selected, each new sweep contributes the max dBm inside that band; keeps the latest 120 samples. Switching events resets the graph. |
| **CURRENT PEAK / NOISE FLOOR / ACTIVE BANDWIDTH / RF EVENTS** | Live summary readouts. |
| **Clear** | Clears the selection state (button in the "Detected RF Interference" title bar). |

### Waterfall history — how it behaves

- Frames are captured at **~1 frame/sec**.
- The server keeps the last `WISPY_HISTORY` frames (**1500 ≈ 25 min**) in memory.
- On page load the browser pulls the entire server buffer, so **a reload does not
  lose history** as long as the server kept running.
- In "Keep N min" modes each frame is bucketed into a time row by age and merged
  with **max-hold** per frequency bin, so short bursts stay visible.
- Empty time buckets are drawn dark. A freshly started server in a 10-min window
  therefore looks mostly dark until enough frames accumulate — this is expected,
  not a bug.
- `Keep 30 min` exceeds the default server buffer: right after a reload you get
  ~25 min max. Raise `WISPY_HISTORY` (e.g. `2700`) for true 30-min history.
- History is **in-memory only** — nothing is written to disk. Restarting the server
  starts from zero.

---

## 6. HTTP API

All endpoints return JSON. They are handy for scripting, dashboards, or checking the
server without a browser.

| Endpoint | Description |
|---|---|
| `GET /api/status` | Frame count, active collector command, port, active band label. |
| `GET /api/frames` | Full frame ring buffer. |
| `GET /api/frames?since=<unix_ts>` | Only frames newer than the given timestamp. |
| `GET /api/events` | Analyzed interference summary: window duration and up to 20 events. |
| `GET /api/range?r=2.4GHz` | Switch to 2.4 GHz at runtime. |
| `GET /api/range?r=5GHz` | Switch to 5 GHz at runtime. |

Each frame looks like:

```json
{"values":[ -95, -93, ... ], "base":-102, "peak":-53, "active_bw":9.7,
 "regions":[{"start":2412.0,"end":2430.5,"center":2421.2,"bw":18.5,"peak":-53}],
 "active_label":"2.4GHz", "ts":1761583921.44}
```

`values` is the sweep in dBm across the active band (285 bins for 2.4 GHz,
458 bins for 5 GHz); frequency of bin *i* is
`F0 + i * (F1 - F0) / (n - 1)`.

Quick checks:

```bash
curl -s http://localhost:8080/api/status
curl -s "http://localhost:8080/api/range?r=5GHz"
curl -s http://localhost:8080/api/events | python3 -m json.tool
```

---

## 7. How it works

```
spectool_raw -r 0:0 (or 0:2)
        │  "Wi-Spy DBx USB 0: <285 or 458 integers>"
        ▼
   collect() thread ──► analyze() ──► deque(maxlen=WISPY_HISTORY)
                                            │
                     ┌──────────────────────┴───────────────────┐
                     ▼                                          ▼
              /api/frames, /api/status                  /api/events (history())
                     │                                          │
                     └────────────► static/app.js ◄─────────────┘
                                        │
                    Canvas: spectrum, waterfall, signal level history
```

- **`collect()`** spawns `spectool_raw`, parses one sweep per line with a regex,
  and pushes an analyzed frame. If the band changes, the child process is killed and
  a fresh one is started for the new range index.
- **`analyze()`** computes the noise floor as the median of the lowest 60 % of bins,
  marks bins ≥ floor + 10 dB as active, groups them into contiguous regions, and
  reports bandwidth/peak for regions ≥ 0.7 MHz wide or ≥ 25 dB above floor.
- **`history()`** aggregates the buffer per bin into a duty-cycle profile, smooths it,
  and classifies regions heuristically (`Broadband interference`, `Continuous
  narrowband`, `Hopping / intermittent narrowband`, `Wideband RF / Wi-Fi-like`,
  `Burst / periodic-like`) with a "likely" label (Bluetooth/BLE-like,
  Zigbee/802.15.4-like, microwave-like, Wi-Fi-like, …) and a confidence score.
- **The HTTP server** is a threaded `BaseHTTPRequestHandler` that serves the two
  static files plus the JSON endpoints; no framework, no database.

### File layout

```
wispy7.0/
├── server.py          # collector thread + analysis + HTTP API (stdlib only)
├── start.sh           # cd-to-own-dir launcher
├── README.md          # this file
└── static/
    ├── index.html     # dashboard layout, band buttons, waterfall window selector
    └── app.js         # polling, canvas rendering, waterfall stacking, UI state
```

---

## 8. Troubleshooting

### Blank spectrum / no waterfall

Symptom: the page loads and shows the frame, but canvases stay dark and the status
line shows 0 frames or "Waiting for waterfall data…".

1. **Check the API from another machine**, not just in the browser:
   ```bash
   curl -m 5 -s http://<host>:8080/api/status
   ```
   - **Connection refused** → server not running: start it and check the log.
   - **Timeout with no output, while `ss -tlnp | grep 8080` still shows a listener**
     → the process is hung (usually a stuck `spectool_raw` child holding the pipe).
     Kill it and restart. Note that a `pkill -f 'server.py'` pattern can fail to
     match when the process was started as `python3 server.py`; kill by PID:
     ```bash
     ps -eo pid,args | grep -E '[s]erver\.py'
     kill -9 <pid>
     ss -tln | grep 8080 || echo "port free"
     cd ~/wispy7.0 && WISPY_RANGE=0:0 WISPY_PORT=8080 \
       setsid nohup python3 server.py > /tmp/w7.log 2>&1 < /dev/null &
     sleep 4 && curl -s http://127.0.0.1:8080/api/status
     ```
   - **JSON returns but `"frames":0`** → the collector is not producing sweeps; see
     the next two items.

2. **Is the device present?**
   ```bash
   spectool_raw -l
   lsusb | grep -i wi-spy
   ```
   No device → cable, antenna, or USB power problem.

3. **Did the collector die?** Run it by hand and look at the output:
   ```bash
   sudo spectool_raw -r 0:0
   ```
   You should see lines starting with `Wi-Spy DBx USB 0:` followed by hundreds of
   integers. If instead you get `Invalid range, no device 0:0`, the range syntax is
   wrong for your `spectools` build — use `-l` to confirm indices. If you get a
   permission error, run under `sudo` or fix the udev rule.

4. **Server started but the log says `spectool_raw not found`** → install
   `spectools` (`sudo apt install spectools`) and confirm `which spectool_raw`.

5. **Frames arrive but the page stays dark** → hard-reload the browser
   (Ctrl+Shift+R) to drop a cached `app.js`, then check the console for JS errors and
   confirm `/api/frames` returns a non-empty array.

### Waterfall looks empty or banded in "Keep 10 min"

Expected when the server just started: only a few seconds of frames exist inside a
600-second window. Let it run, or pick a shorter window. Banding/gaps also appear if
frames are dropped (USB hiccups) — check the server log for `collector:` errors.

### Band switch does nothing / wrong band shown

- Confirm `GET /api/status` returns the expected `active_label`.
- The server clears its buffer on switch by design; the waterfall will look empty for
  a few seconds afterwards.
- If the hardware refuses to retune (device busy), the old `spectool_raw` child may
  not have exited — restart the server.

### Port already in use

```bash
ss -tlnp | grep 8080
```

Either stop the old instance or start on another port: `WISPY_PORT=8090 python3 server.py`.

### High CPU or sluggish UI on a Pi

Lower the browser cost by using `Keep 1 min` or `Live rolling`, and avoid leaving
many tabs open. The server side is cheap (one sweep/sec); rendering dominates.

### Remote access blocked

The server binds `0.0.0.0` by default. If a browser on another machine cannot connect
but `curl` on the host works, check the host firewall:

```bash
sudo ufw status            # if ufw is installed
sudo ufw allow 8080/tcp
```

---

## 9. Notes and limitations

- **One sweep per second** — this is a monitoring/classification tool, not a
  real-time signal analyzer. Fast frequency-hopping details will be aliased.
- **Classification is heuristic**, based on bandwidth, duty cycle and peak. Treat
  "likely" labels as hints, not identifications.
- **In-memory history only** — no persistence, no export. Restarting the server or
  the Pi clears all frames.
- **Single device** — `collect()` manages one `spectool_raw` child for device 0.
- **No authentication** — the dashboard and API are open. Run it on a trusted network
  or bind to `127.0.0.1` behind a reverse proxy.
- 5 GHz analysis thresholds are inherited from the 2.4 GHz tuning; they are usable but
  not specifically calibrated for UNII bands.

---

## 10. Changelog

**v7.0.0**
- Runtime band switching between 2.4 GHz (`0:0`) and 5 GHz (`0:2`) via UI buttons or
  `/api/range`, with buffer clearing so bands never mix.
- `active_label` exposed in `/api/status`, `/api/frames` and `/api/events`.
- Waterfall time-history window selector (Live / 1 / 5 / 10 / 30 min) with max-hold
  stacking and age labels; server ring buffer raised to 1500 frames.
- Verified against Wi-Spy DBx3 on Debian 13 (trixie), kernel 6.12.62+rpt-rpi-v8.

**v5.6**
- Signal Level History uses a dedicated browser-side buffer; after selecting an
  interference event, each new scan contributes the max dBm inside that band, keeping
  the latest 120 samples.
- Event selection is exclusive: only the clicked event gets the yellow border.
- Selecting a different event clears and restarts signal history.
- Layout preserved: Live Spectrum left; Source Hunt right of it plus Waterfall;
  Waterfall below Live Spectrum; Detected RF Interference below the waterfall; Wi-Fi
  channel numbers directly under the spectrum frequency axis.
.
