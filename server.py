#!/usr/bin/env python3
import os,re,json,time,signal,subprocess,threading
from collections import deque
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlparse,parse_qs

HOST=os.getenv("WISPY_HOST","0.0.0.0"); PORT=int(os.getenv("WISPY_PORT","8080"))
RANGE=os.getenv("WISPY_RANGE","0:0")
F0=2400.; F1=2495.; F0_FIVE=5150.; F1_FIVE=5836.
# spectool_raw -r takes DEVICE:RANGE_INDEX (not MHz). Wi-Spy DBx3 ranges:
#   0 = Full 2.4GHz Band (2400-2495), 2 = Full 5GHz Band (5150-5836)

# mutable active range (can be switched at runtime via /api/range)
CURRENT_RANGE=RANGE
ACTIVE_F0=F0; ACTIVE_F1=F1; ACTIVE_LABEL="2.4GHz"
if ":" in RANGE:
    try:
        parts=RANGE.split(":")
        rng_idx=int(parts[1]) if len(parts)>1 else 0
        # device 0 range >=2 = 5GHz band; also tolerate legacy MHz-style values
        if rng_idx>=2 or float(parts[0])>=5000:
            ACTIVE_F0=F0_FIVE; ACTIVE_F1=F1_FIVE; ACTIVE_LABEL="5GHz"
    except (ValueError,IndexError):
        pass

HISTORY=int(os.getenv("WISPY_HISTORY","1500")); frames=deque(maxlen=HISTORY); lock=threading.Lock(); stop=threading.Event()
range_lock=threading.Lock(); current_proc=[None]; gen=[0]
rx=re.compile(r"^Wi-Spy DBx USB[^:]*:\s+(.+)$"); BASE=Path(__file__).parent
WIFI_INTERFACE = os.getenv("WISPY_WIFI_INTERFACE")
wifi_snapshot = {"interface": None, "networks": [], "error": None}


def nmcli(fields, *args):
    return subprocess.run(
        ["nmcli", "--colors", "no", "--terse", "--escape", "yes",
         "--fields", fields, *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env={**os.environ, "LC_ALL": "C.UTF-8"}, check=True, timeout=20,
    ).stdout


def wifi_interface():
    if WIFI_INTERFACE:
        return WIFI_INTERFACE
    for row in nmcli("TYPE,STATE,DEVICE", "device", "status").split("\n"):
        kind, state, name = row.split(":", 2) if row else ("", "", "")
        if kind != "wifi" or state == "unmanaged":
            continue
        device = Path("/sys/class/net", name, "device")
        if device.exists() and not any(re.fullmatch(r"usb\d+", part)
                                       for part in device.resolve().parts):
            return name
    return None


def wifi_networks(output, readings, has_bandwidth=True):
    networks = {}
    field_count = 4 if has_bandwidth else 3
    for row in output.split("\n"):
        address = re.match(r"^([0-9a-f]{2}(?:\\?:[0-9a-f]{2}){5}):", row, re.I)
        if not address:
            continue
        bssid = address[1].replace("\\", "").lower()
        fields = row[address.end():].rsplit(":", field_count - 1)
        if len(fields) != field_count:
            continue
        name, frequency, signal = fields[:3]
        if not name:
            continue
        try:
            mhz = int(frequency.removesuffix(" MHz"))
            strength = int(signal)
        except ValueError:
            continue
        bandwidth = fields[3].removesuffix(" MHz") if has_bandwidth else ""
        width = int(bandwidth) if bandwidth.isascii() and bandwidth.isdecimal() else 0
        ssid = re.sub(r"\\([:\\])", r"\1", name)
        key = (ssid, mhz)
        dbm = readings.get((bssid, mhz))
        if key not in networks or strength > networks[key]["signal"] or (
            strength == networks[key]["signal"] and dbm is not None and
            (networks[key]["dbm"] is None or dbm > networks[key]["dbm"])
        ):
            networks[key] = {"ssid": ssid, "mhz": mhz, "signal": strength,
                             "width": width or None, "dbm": dbm}
    return sorted(networks.values(), key=lambda network: -network["signal"])


def wifi_dbm(interface):
    try:
        output = subprocess.run(
            ["iw", "dev", interface, "scan", "dump"], capture_output=True,
            text=True, encoding="utf-8", errors="replace",
            env={**os.environ, "LC_ALL": "C"}, check=True, timeout=5,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    readings = {}
    for entry in re.split(r"(?m)^BSS ", output)[1:]:
        address = re.match(r"[0-9a-f]{2}(?::[0-9a-f]{2}){5}", entry, re.I)
        frequency = re.search(r"(?m)^[ \t]+freq:[ \t]+(\d+)", entry)
        signal = re.search(r"(?m)^[ \t]+signal:[ \t]+(-?\d+(?:\.\d+)?) dBm[ \t]*$", entry)
        if address and frequency and signal:
            readings[address[0].lower(), int(frequency[1])] = float(signal[1])
    return readings


def scan_wifi(interface):
    args = ("device", "wifi", "list", "ifname", interface, "--rescan", "auto")
    has_bandwidth = True
    try:
        output = nmcli("BSSID,SSID,FREQ,SIGNAL,BANDWIDTH", *args)
    except subprocess.CalledProcessError as exc:
        if "invalid field" not in exc.stderr.lower():
            raise
        output = nmcli("BSSID,SSID,FREQ,SIGNAL", *args)
        has_bandwidth = False
    return wifi_networks(output, wifi_dbm(interface) if output else {}, has_bandwidth)


def collect_wifi():
    global wifi_snapshot
    while not stop.is_set():
        interface = None
        networks = []
        error = None
        try:
            interface = wifi_interface()
            if interface:
                networks = scan_wifi(interface)
            else:
                error = "No onboard Wi-Fi interface managed by NetworkManager"
        except FileNotFoundError:
            error = "nmcli is unavailable"
        except subprocess.CalledProcessError as exc:
            error = exc.stderr.strip() or "Wi-Fi scan failed"
        except subprocess.TimeoutExpired:
            error = "Wi-Fi scan timed out"
        wifi_snapshot = {"interface": interface, "networks": networks, "error": error}
        stop.wait(15)

def set_active_range(label):
    global CURRENT_RANGE,ACTIVE_F0,ACTIVE_F1,ACTIVE_LABEL
    with range_lock:
        if label=="5GHz":
            CURRENT_RANGE="0:2"; ACTIVE_F0=F0_FIVE; ACTIVE_F1=F1_FIVE; ACTIVE_LABEL="5GHz"
        else:
            CURRENT_RANGE="0:0"; ACTIVE_F0=F0; ACTIVE_F1=F1; ACTIVE_LABEL="2.4GHz"
        gen[0]+=1
    with lock: frames.clear()

def med(a):
    a=sorted(a); n=len(a)
    return a[n//2] if n%2 else (a[n//2-1]+a[n//2])/2

def regions(active):
    out=[];i=0
    while i<len(active):
        if not active[i]: i+=1;continue
        j=i
        while j+1<len(active) and active[j+1]: j+=1
        out.append((i,j));i=j+1
    return out

def analyze(v):
    n=len(v); step=(ACTIVE_F1-ACTIVE_F0)/max(1,n-1); base=med(sorted(v)[:max(1,int(n*.6))]); act=[x>=base+10 for x in v]
    rs=[]
    for a,b in regions(act):
        bw=(b-a+1)*step; pk=max(v[a:b+1])
        if bw>=.7 or pk>=base+25:
            rs.append({"start":round(ACTIVE_F0+a*step,2),"end":round(ACTIVE_F0+b*step,2),"center":round(ACTIVE_F0+(a+b)*step/2,2),"bw":round(bw,2),"peak":pk})
    return {"values":v,"base":round(base,1),"peak":max(v),"active_bw":round(sum(act)*step,2),"regions":rs,"active_label":ACTIVE_LABEL}

def history(fs):
    if len(fs)<5:return {"seconds":0,"events":[]}
    n=len(fs[-1]["values"]); step=(ACTIVE_F1-ACTIVE_F0)/max(1,n-1); fs=[f for f in fs if len(f["values"])==n]
    p=[0]*n
    for f in fs:
        for i,x in enumerate(f["values"]):
            if x>=f["base"]+10:p[i]+=1
    p=[x/len(fs) for x in p]
    sm=[sum(p[max(0,i-1):min(n,i+2)])/len(p[max(0,i-1):min(n,i+2)]) for i in range(n)]
    ev=[]
    for a,b in regions([x>=.12 for x in sm]):
        bw=(b-a+1)*step; center=ACTIVE_F0+(a+b)*step/2; bp=sum(p[a:b+1])/(b-a+1)
        duty=sum(max(f["values"][a:b+1])>=f["base"]+10 for f in fs)/len(fs)
        peak=max(max(f["values"][a:b+1]) for f in fs)
        if bw>=35: typ="Broadband interference"
        elif bw<=4 and duty>=.65: typ="Continuous narrowband"
        elif bw<=4 and duty>=.12 and bp/max(duty,.001)<.65: typ="Hopping / intermittent narrowband"
        elif 14<=bw<=30 and duty>=.30: typ="Wideband RF / Wi-Fi-like"
        elif duty<.35 and bw<=12: typ="Burst / periodic-like"
        else: typ="Unknown RF"
        if typ.startswith("Hopping") and bw<=4: likely="Bluetooth/BLE-like hopping"
        elif 1.5<=bw<=3.5 and 2405<=center<=2480 and duty>=10/100: likely="802.15.4/Zigbee-like"
        elif bw>=35 and 2420<=center<=2480: likely="Broadband / microwave-like"
        elif typ=="Continuous narrowband": likely="Continuous narrowband transmitter"
        elif typ=="Burst / periodic-like": likely="Periodic/burst transmitter"
        elif typ=="Wideband RF / Wi-Fi-like": likely="Wi-Fi-like / wideband"
        else: likely="Unknown non-Wi-Fi candidate"
        conf=min(99,int(50+40*min(1,duty)))
        ev.append({"start":round(ACTIVE_F0+a*step,2),"end":round(ACTIVE_F0+b*step,2),"center":round(center,2),"bw":round(bw,2),"duty":round(duty*100,1),"peak":peak,"pattern":typ,"likely":likely,"confidence":conf})
    return {"seconds":round(fs[-1]["ts"]-fs[0]["ts"],1),"events":sorted(ev,key=lambda x:x["peak"],reverse=True)[:20]}

def collect():
    while not stop.is_set():
        try:
            with range_lock:
                rng=CURRENT_RANGE; g=gen[0]
            p=subprocess.Popen(["spectool_raw","-r",rng],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
            current_proc[0]=p
            shutting_down = stop.is_set()
            if shutting_down:
                p.terminate()
            for line in (() if shutting_down else p.stdout):
                if stop.is_set(): break
                if gen[0]!=g: break
                m=rx.match(line.strip())
                if not m: continue
                try: v=[int(x) for x in m.group(1).split()]
                except: continue
                if len(v)<20: continue
                f=analyze(v); f["ts"]=time.time()
                with lock: frames.append(f)
            try: p.wait(timeout=2)
            except Exception:
                try: p.kill()
                except Exception: pass
                p.wait()
        except FileNotFoundError:
            print("spectool_raw not found; install spectools");return
        except Exception as e: print("collector:",e)
        current_proc[0]=None
        stop.wait(1)

class H(BaseHTTPRequestHandler):
    def log_message(self,*a):pass
    def out(self,data,typ):
        self.send_response(200);self.send_header("Content-Type",typ);self.send_header("Cache-Control","no-store");self.send_header("Content-Length",str(len(data)));self.end_headers();self.wfile.write(data)
    def do_GET(self):
        parsed=urlparse(self.path); path=parsed.path
        if path in ("/","/index.html"):return self.out((BASE/"static/index.html").read_bytes(),"text/html; charset=utf-8")
        if path=="/app.js":return self.out((BASE/"static/app.js").read_bytes(),"text/javascript; charset=utf-8")
        if path=="/api/wifi":
            return self.out(json.dumps(wifi_snapshot).encode(),"application/json")
        if path=="/api/range":
            q=parse_qs(parsed.query); r=q.get("r",["2.4GHz"])[0]
            set_active_range(r)
            pr=current_proc[0]
            if pr:
                try: pr.terminate()
                except Exception: pass
            with lock: frames.clear()      # drop old-band frames so the UI never mixes bands
            return self.out(json.dumps({"ok":True,"range":ACTIVE_LABEL,"collector":"spectool_raw -r "+CURRENT_RANGE},separators=(",",":")).encode(),"application/json")
        with lock: fs=list(frames)
        if path=="/api/frames":
            q=parse_qs(parsed.query); since=0.0
            try: since=float(q.get("since",["0"])[0] or 0)
            except ValueError: pass
            out=[f for f in fs if f["ts"]>since] if since>0 else fs
            return self.out(json.dumps(out,separators=(",",":")).encode(),"application/json")
        if path=="/api/events":return self.out(json.dumps(history(fs),separators=(",",":")).encode(),"application/json")
        if path=="/api/status":
            return self.out(json.dumps({"frames":len(fs),"collector":"spectool_raw -r "+CURRENT_RANGE,"port":PORT,"active_label":ACTIVE_LABEL},separators=(",",":")).encode(),"application/json")
        self.send_response(404);self.end_headers()

def main():
    with ThreadingHTTPServer((HOST, PORT), H) as server:
        server.timeout = 0.25
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        collector = threading.Thread(target=collect, daemon=True)
        collector.start()
        threading.Thread(target=collect_wifi, daemon=True).start()
        print(f"Wi-Spy analyzer v7: http://{HOST}:{server.server_port} range={ACTIVE_LABEL}", flush=True)
        try:
            while not stop.is_set():
                server.handle_request()
        finally:
            stop.set()
            proc = current_proc[0]
            if proc is not None:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            collector.join(timeout=3)
if __name__=="__main__":main()
