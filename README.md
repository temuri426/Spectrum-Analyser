# Wi-Spy DBx3 v5.6

Fixes requested:

1. Signal Level History now uses a dedicated browser-side history buffer. After selecting an interference event, every new DBx3 scan contributes the maximum dBm level inside the selected frequency band. The graph updates continuously and keeps the latest 120 samples.
2. Detected RF Interference selection is exclusive: only the clicked event gets the yellow selected border. All other events have transparent borders.
3. Selecting a different event clears the previous signal history and starts history for the newly selected event.
4. The v5.5 layout is preserved:
   - Live Spectrum left
   - Source Hunt right of Live Spectrum + Waterfall
   - Waterfall below Live Spectrum
   - Detected RF Interference below the waterfall
   - Wi-Fi channel numbers directly under the spectrum frequency axis

Run:
```bash
sudo pkill -f 'python3 server.py'
sudo pkill -f spectool_raw
cd ~/wispy-interference-hunter-v5.6
sudo python3 server.py
```
