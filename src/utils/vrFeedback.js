// Feedback that reaches a pilot wearing a VR headset: short audio cues (they
// play through the default audio device, which is normally the headset) and a
// text line drawn inside DCS by TheWay.lua.
import store from "../store";

const { ipcRenderer } = window.require("electron");

// Each cue is a list of [frequencyHz, durationMs] notes played in sequence.
const CUES = {
  crosshairOn: [[660, 70], [990, 90]],
  crosshairOff: [[990, 70], [660, 90]],
  save: [[1320, 80]],
  deleteLast: [[440, 110]],
  deleteAll: [[440, 90], [0, 40], [330, 140]],
  transferStart: [[523, 80], [659, 80], [784, 110]],
  transferDone: [[784, 90], [0, 30], [1047, 160]],
  abort: [[784, 90], [523, 90], [392, 160]],
  error: [[220, 180], [0, 40], [220, 180]],
  prompt: [[880, 70], [0, 40], [880, 70]],
};

let audioContext = null;

// "off" | "tones" | "voice". Older settings only had the soundCues checkbox.
export const audioMode = () => {
  const prefs = store.getState().ui.userPreferences || {};
  if (["off", "tones", "voice"].includes(prefs.audioCues)) return prefs.audioCues;
  return prefs.soundCues === false ? "off" : "tones";
};

const statusEnabled = () =>
  store.getState().ui.userPreferences?.dcsStatusText !== false;

// Many USB headsets, DACs and monitor speakers power down after a few seconds
// of silence and swallow the first fraction of a second when they wake, which
// is a whole tone (or the first spoken word). While audio cues are on, keep an
// output stream open with a tiny DC offset: inaudible, but not digital
// silence, so neither Chromium nor the device treats the stream as idle.
let keepAwakeNode = null;

const getAudioContext = () => {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === "suspended") audioContext.resume();
  return audioContext;
};

const syncKeepAwake = () => {
  const wanted = audioMode() !== "off";
  try {
    if (wanted && !keepAwakeNode) {
      const ctx = getAudioContext();
      keepAwakeNode = ctx.createConstantSource();
      keepAwakeNode.offset.value = 0.0001;
      keepAwakeNode.connect(ctx.destination);
      keepAwakeNode.start();
    } else if (!wanted && keepAwakeNode) {
      keepAwakeNode.stop();
      keepAwakeNode.disconnect();
      keepAwakeNode = null;
    }
  } catch (e) {
    console.log("[TheWay] audio keep-awake failed:", e);
  }
};

// Follow the setting as it changes (and once preferences load at startup)
store.subscribe(syncKeepAwake);

// ---------- Speech (Windows voice, rendered in electron/speech.js) ----------

const radioEnabled = () =>
  store.getState().ui.userPreferences?.speechRadio !== false;

let speechToken = 0; // newest phrase wins; older renders are dropped
let speechNodes = []; // nodes of the phrase now playing, stopped by the next one

const stopSpeech = () => {
  for (const n of speechNodes) {
    try {
      n.stop();
    } catch {}
  }
  speechNodes = [];
};

let noiseBuffer = null;
const getNoise = (ctx) => {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
};

// Band-limited static from `start` for `dur` seconds, with an envelope
const playStatic = (ctx, out, start, dur, level, fadeIn = 0.005, fadeOut = 0.03) => {
  const src = ctx.createBufferSource();
  src.buffer = getNoise(ctx);
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 2200;
  band.Q.value = 0.7;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(level, start + fadeIn);
  g.gain.setValueAtTime(level, Math.max(start + fadeIn, start + dur - fadeOut));
  g.gain.linearRampToValueAtTime(0, start + dur);
  src.connect(band).connect(g).connect(out);
  src.start(start, Math.random());
  src.stop(start + dur + 0.01);
  speechNodes.push(src);
};

// Short key-up / key-down click
const playClick = (ctx, out, at, freq) => {
  const osc = ctx.createOscillator();
  osc.type = "square";
  osc.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.18, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + 0.025);
  osc.connect(g).connect(out);
  osc.start(at);
  osc.stop(at + 0.03);
  speechNodes.push(osc);
};

// Soft-clipping curve for a little radio grit
let gritCurve = null;
const getGritCurve = () => {
  if (!gritCurve) {
    const n = 1024;
    gritCurve = new Float32Array(n);
    const k = 6;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      gritCurve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
  }
  return gritCurve;
};

const playVoice = (ctx, audio, radio) => {
  const now = ctx.currentTime + 0.02;
  const voice = ctx.createBufferSource();
  voice.buffer = audio;
  speechNodes.push(voice);

  if (!radio) {
    voice.connect(ctx.destination);
    voice.start(now);
    return;
  }

  // Everything goes through one radio "speaker": telephone band + grit
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 400;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 3000;
  const drive = ctx.createGain();
  drive.gain.value = 1.8;
  const shaper = ctx.createWaveShaper();
  shaper.curve = getGritCurve();
  const out = ctx.createGain();
  out.gain.value = 0.55;
  hp.connect(lp).connect(drive).connect(shaper).connect(out).connect(ctx.destination);

  const keyUp = 0.09; // click + burst of static before the voice
  const voiceStart = now + keyUp;
  const voiceEnd = voiceStart + audio.duration;
  const tail = 0.16; // squelch tail after the voice

  playClick(ctx, ctx.destination, now, 1800);
  playStatic(ctx, ctx.destination, now, keyUp, 0.12, 0.003, 0.04);
  playStatic(ctx, hp, voiceStart, audio.duration, 0.035, 0.02, 0.02); // static bed under the voice
  voice.connect(hp);
  voice.start(voiceStart);
  playStatic(ctx, ctx.destination, voiceEnd, tail, 0.16, 0.004, 0.09); // "kssh"
  playClick(ctx, ctx.destination, voiceEnd + tail, 1400);
};

// Windows pads phrases with silence (about 0.7 s after "Crosshair on."); trim
// it so the radio squelch tail follows the last word instead of a pause.
export const trimSilence = (ctx, audio, threshold = 0.01, padSeconds = 0.03) => {
  const data = audio.getChannelData(0);
  let first = 0;
  while (first < data.length && Math.abs(data[first]) < threshold) first++;
  let last = data.length - 1;
  while (last > first && Math.abs(data[last]) < threshold) last--;
  if (first >= last) return audio;
  const pad = Math.round(padSeconds * audio.sampleRate);
  const start = Math.max(0, first - pad);
  const end = Math.min(data.length, last + pad);
  const out = ctx.createBuffer(audio.numberOfChannels, end - start, audio.sampleRate);
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    out.copyToChannel(audio.getChannelData(ch).subarray(start, end), ch);
  }
  return out;
};

// Speak a phrase with the Windows voice; a newer phrase cuts this one off.
// fallbackCue: tone to play instead if speech isn't available.
export const speak = async (text, fallbackCue) => {
  if (!text) return;
  const token = ++speechToken;
  try {
    const b64 = await ipcRenderer.invoke("speech:render", text);
    if (token !== speechToken) return; // superseded while rendering
    if (!b64) {
      if (fallbackCue) playTone(fallbackCue);
      return;
    }
    const ctx = getAudioContext();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const audio = await ctx.decodeAudioData(bytes.buffer);
    if (token !== speechToken) return;
    stopSpeech();
    playVoice(ctx, trimSilence(ctx, audio), radioEnabled());
  } catch (e) {
    console.log("[TheWay] speech failed:", e);
  }
};

// say: the phrase to speak in voice mode; without one, voice mode falls back
// to the tone. mode: override the setting (used by the Test button).
export const playCue = (name, { say, mode } = {}) => {
  const m = mode || audioMode();
  if (m === "off") return;
  if (m === "voice" && say) {
    speak(say, name);
    return;
  }
  playTone(name);
};

const playTone = (name) => {
  const notes = CUES[name];
  if (!notes) return;

  try {
    if (!audioContext) audioContext = new AudioContext();
    if (audioContext.state === "suspended") audioContext.resume();

    let t = audioContext.currentTime + 0.01;
    for (const [freq, ms] of notes) {
      const dur = ms / 1000;
      if (freq > 0) {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        // short attack/release so the tone doesn't click
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.25, t + 0.01);
        gain.gain.setValueAtTime(0.25, t + Math.max(0.01, dur - 0.02));
        gain.gain.linearRampToValueAtTime(0, t + dur);
        osc.connect(gain).connect(audioContext.destination);
        osc.start(t);
        osc.stop(t + dur + 0.02);
      }
      t += dur;
    }
  } catch (e) {
    console.log("[TheWay] sound cue failed:", e);
  }
};

// Show a line of text inside DCS. ms = 0 keeps it until replaced or cleared.
export const dcsStatus = (text, ms = 3000) => {
  if (!statusEnabled() && text !== "") return;
  ipcRenderer.send("messageToDcs", {
    type: "status",
    payload: { text: String(text ?? ""), ms },
  });
};

// onlyIf: clear only if DCS is still showing exactly this text, so a late
// clear cannot wipe a newer message.
export const clearDcsStatus = (onlyIf) => {
  ipcRenderer.send("messageToDcs", {
    type: "status",
    payload: { text: "", ms: 0, onlyIf },
  });
};

// cue: tone name; text: DCS status line; say: phrase for voice mode
export const notify = (cue, text, ms = 3000, say) => {
  if (cue) playCue(cue, { say });
  if (text) dcsStatus(text, ms);
};

// Mirror an option dialog into DCS so it can be answered from the headset
// with the Option 1-4 bindings. Returns a cleanup function.
export const showDcsPrompt = (title, options) => {
  const line = options
    .map((op, i) => (op ? `[${i + 1}] ${op}` : null))
    .filter(Boolean)
    .join("    ");
  const text = `${title}\n${line}`;
  const say = `${title}. ${options
    .map((op, i) => (op ? `${i + 1}: ${op}.` : null))
    .filter(Boolean)
    .join(" ")}`;
  playCue("prompt", { say });
  dcsStatus(text, 0);
  return () => clearDcsStatus(text);
};
