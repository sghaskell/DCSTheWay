// Joystick / HOTAS / button-box bindings for TheWay actions.
//
// Input comes from RawJoystickReader (Windows Raw Input + HID parsing in the
// main process), which keeps working while DCS has focus and sees every button
// (up to 128) and hat. Note: nothing in the app may call
// navigator.getGamepads(); Chromium would then register its own Raw Input
// listener for joysticks and take over this one (one listener per process).
//
// Binding format stored in preferences under joyBinds.<action>:
//   "JOY|<VID_xxxx&PID_xxxx>|<n-th identical device>|<control>|<device name>"
// control is a button number ("22", same as DCS JOY_BTN22) or e.g. "hat1up".
// Only the first four fields are matched; the name is for display.
const { BrowserWindow, ipcMain } = require("electron");
const Store = require("electron-store");
const { runAction } = require("./keybindListener");
const RawJoystickReader = require("./rawJoystick");

const CAPTURE_TIMEOUT_MS = 10000;

const matchKey = (binding) => binding.split("|").slice(0, 4).join("|");

class JoystickListener {
  constructor(getMainWindow) {
    this.getMainWindow = getMainWindow;
    this.store = new Store();
    this.bindings = new Map(); // match key -> action name
    this.pendingCapture = null; // { resolve, timer }
    this.inputWindow = null;
    this.reader = null;

    this.reload();
    this.#startReader();

    ipcMain.removeHandler("joy:capture");
    ipcMain.handle("joy:capture", () => this.#capture());

    ipcMain.removeAllListeners("joy:cancelCapture");
    ipcMain.on("joy:cancelCapture", () => this.#finishCapture(null));
  }

  // Re-read joystick bindings from the preference store.
  reload() {
    const joyBinds = this.store.get("joyBinds") || {};
    this.bindings.clear();
    for (const [action, binding] of Object.entries(joyBinds)) {
      if (typeof binding === "string" && binding.startsWith("JOY|")) {
        this.bindings.set(matchKey(binding), action);
      }
    }
  }

  #startReader() {
    // Raw Input is delivered to a window; a hidden one is enough.
    this.inputWindow = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      frame: false,
      focusable: false,
      skipTaskbar: true,
    });
    this.inputWindow.on("closed", () => {
      this.inputWindow = null;
    });

    this.reader = new RawJoystickReader();
    this.reader.on("error", (e) => console.log("[TheWay] joystick input error:", e.message));
    this.reader.on("press", (press) => this.#onPress(press));
    try {
      this.reader.start(this.inputWindow);
      const names = this.reader.listDevices().map((d) => d.name);
      console.log(`[TheWay] joysticks: ${names.length ? names.join(", ") : "none found"}`);
    } catch (e) {
      console.log("[TheWay] joystick input unavailable:", e.message);
    }
  }

  #onPress({ device, occ, control, name }) {
    const binding = `JOY|${device}|${occ}|${control}|${name}`;

    if (this.pendingCapture) {
      this.#finishCapture(binding);
      return;
    }

    const action = this.bindings.get(matchKey(binding));
    if (action) runAction(this.getMainWindow(), action);
  }

  #capture() {
    this.#finishCapture(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#finishCapture(null), CAPTURE_TIMEOUT_MS);
      this.pendingCapture = { resolve, timer };
    });
  }

  #finishCapture(result) {
    if (!this.pendingCapture) return;
    clearTimeout(this.pendingCapture.timer);
    const { resolve } = this.pendingCapture;
    this.pendingCapture = null;
    resolve(result);
  }

  destroy() {
    this.#finishCapture(null);
    if (this.reader) this.reader.stop();
    if (this.inputWindow && !this.inputWindow.isDestroyed()) {
      this.inputWindow.destroy();
    }
  }
}

module.exports = JoystickListener;
