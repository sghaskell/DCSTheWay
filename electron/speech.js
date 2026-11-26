// Spoken announcements through the Windows speech engine (SAPI).
//
// Chromium's speechSynthesis has no voices inside Electron on Windows, so the
// main process keeps one PowerShell process with System.Speech loaded and feeds
// it phrases on stdin. Starting it once keeps each phrase fast.
//
// Phrases are rendered to WAV (not played by SAPI) and handed to the renderer,
// which plays them through Web Audio: that lets it add the radio effect, cut
// off a phrase when a new one starts, and use the same output stream as the
// tones (the one kept awake so the first word isn't clipped).
const { spawn } = require("child_process");
const { ipcMain } = require("electron");
const Store = require("electron-store");

const RENDER_TIMEOUT_MS = 5000;

const SPEECH_SCRIPT = `
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
[Console]::Out.WriteLine('VOICES ' + (($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }) -join '|'))
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $id = 0
  try {
    $m = $line | ConvertFrom-Json
    $id = [int]$m.id
    if ($m.voice) { try { $s.SelectVoice($m.voice) } catch {} }
    $s.Rate = [int]$m.rate
    $s.Volume = 100
    $ms = New-Object IO.MemoryStream
    $s.SetOutputToWaveStream($ms)
    $s.Speak([string]$m.text)
    $s.SetOutputToNull()
    [Console]::Out.WriteLine('WAV ' + $id + ' ' + [Convert]::ToBase64String($ms.ToArray()))
  } catch {
    [Console]::Out.WriteLine('ERROR ' + $id + ' ' + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
`;

class Speaker {
  constructor() {
    this.store = new Store();
    this.proc = null;
    this.voices = [];
    this.voiceWaiters = [];
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, timer }

    // Returns the phrase as base64 WAV, or null if speech is unavailable
    ipcMain.removeHandler("speech:render");
    ipcMain.handle("speech:render", (_e, text) => this.render(text));

    ipcMain.removeHandler("speech:voices");
    ipcMain.handle("speech:voices", () => this.getVoices());

    // Warm up now if voice announcements are on, so the first one isn't late
    if (this.store.get("audioCues") === "voice") this.#ensureProcess();
  }

  #ensureProcess() {
    if (this.proc) return this.proc;
    if (process.platform !== "win32") return null;

    // The script goes in -EncodedCommand (UTF-16LE base64); stdin carries only
    // the phrases, one JSON object per line.
    const encoded = Buffer.from(SPEECH_SCRIPT, "utf16le").toString("base64");
    const proc = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.proc = proc;

    let out = "";
    proc.stdout.on("data", (d) => {
      out += d.toString();
      let nl;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        this.#onLine(line);
      }
    });
    proc.stderr.on("data", (d) => {
      const text = d.toString().trim();
      // PowerShell serialises its progress stream to stderr; that's not an error
      if (text && !text.startsWith("#< CLIXML") && !text.includes("<Objs ")) {
        console.log("[TheWay] speech stderr:", text);
      }
    });
    const onGone = () => {
      if (this.proc === proc) this.proc = null;
      this.voiceWaiters.splice(0).forEach((r) => r(this.voices));
      for (const id of [...this.pending.keys()]) this.#settle(id, null);
    };
    proc.on("exit", onGone);
    proc.on("error", (e) => {
      console.log("[TheWay] speech unavailable:", e.message);
      onGone();
    });

    return proc;
  }

  #onLine(line) {
    if (line.startsWith("VOICES ")) {
      this.voices = line.slice(7).split("|").filter(Boolean);
      this.voiceWaiters.splice(0).forEach((r) => r(this.voices));
    } else if (line.startsWith("WAV ")) {
      const sp = line.indexOf(" ", 4);
      this.#settle(Number(line.slice(4, sp)), line.slice(sp + 1));
    } else if (line.startsWith("ERROR ")) {
      const rest = line.slice(6);
      const sp = rest.indexOf(" ");
      console.log("[TheWay] speech:", rest.slice(sp + 1));
      this.#settle(Number(rest.slice(0, sp)), null);
    }
  }

  #settle(id, wav) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(wav);
  }

  render(text) {
    const proc = this.#ensureProcess();
    if (!proc || !proc.stdin.writable || !text) return Promise.resolve(null);
    const id = this.nextId++;
    const msg = {
      id,
      text: String(text).slice(0, 300),
      voice: this.store.get("speechVoice") || "",
      rate: Number(this.store.get("speechRate") ?? 1),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#settle(id, null), RENDER_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      proc.stdin.write(JSON.stringify(msg) + "\r\n");
    });
  }

  getVoices() {
    if (this.voices.length) return Promise.resolve(this.voices);
    if (!this.#ensureProcess()) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.voiceWaiters.push(resolve);
      setTimeout(() => resolve(this.voices), 5000);
    });
  }

  destroy() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch {}
      this.proc = null;
    }
  }
}

module.exports = Speaker;
