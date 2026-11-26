// Reads joysticks, throttles, bases and button boxes through Windows Raw Input
// and the HID parser, in the main process.
//
// Why not the browser Gamepad API: Chromium stops delivering joystick input
// once the app isn't the foreground window, and in VR DCS always is. Raw Input
// with RIDEV_INPUTSINK delivers to a background window, and HID parsing sees
// every button (up to 128, e.g. Moza/VKB grips numbered above 32) and hats.
//
// Emits "press" with { device, name, occ, control } where control is a button
// number ("5", matching DCS's JOY_BTN5) or a hat direction ("hat1up").
const { EventEmitter } = require("events");
const { execSync } = require("child_process");
const koffi = require("koffi");

const WM_INPUT = 0x00ff;
const RID_INPUT = 0x10000003;
const RIDI_PREPARSEDDATA = 0x20000005;
const RIDI_DEVICENAME = 0x20000007;
const RIDI_DEVICEINFO = 0x2000000b;
const RIM_TYPEHID = 2;
const RIDEV_INPUTSINK = 0x00000100;
const HIDP_INPUT = 0;
const HIDP_STATUS_SUCCESS = 0x00110000;
const PAGE_GENERIC = 0x01;
const PAGE_BUTTON = 0x09;
const USAGE_HAT = 0x39;
const PTR = 8; // 64-bit Windows only
const RAWINPUTHEADER_SIZE = 8 + 2 * PTR;

let api = null;
const loadApi = () => {
  if (api) return api;
  const user32 = koffi.load("user32.dll");
  const hid = koffi.load("hid.dll");
  api = {
    GetRawInputDeviceList: user32.func(
      "uint32 __stdcall GetRawInputDeviceList(_Inout_ uint8_t *list, _Inout_ uint32 *count, uint32 size)",
    ),
    RegisterRawInputDevices: user32.func(
      "int __stdcall RegisterRawInputDevices(const uint8_t *devices, uint32 count, uint32 size)",
    ),
    GetRawInputData: user32.func(
      "uint32 __stdcall GetRawInputData(uintptr_t h, uint32 cmd, _Inout_ uint8_t *data, _Inout_ uint32 *size, uint32 headerSize)",
    ),
    GetRawInputDeviceInfoW: user32.func(
      "uint32 __stdcall GetRawInputDeviceInfoW(uintptr_t h, uint32 cmd, _Inout_ uint8_t *data, _Inout_ uint32 *size)",
    ),
    HidP_GetCaps: hid.func("int32 __stdcall HidP_GetCaps(const uint8_t *pp, _Out_ uint8_t *caps)"),
    HidP_GetButtonCaps: hid.func(
      "int32 __stdcall HidP_GetButtonCaps(int type, _Out_ uint8_t *caps, _Inout_ uint16 *len, const uint8_t *pp)",
    ),
    HidP_GetValueCaps: hid.func(
      "int32 __stdcall HidP_GetValueCaps(int type, _Out_ uint8_t *caps, _Inout_ uint16 *len, const uint8_t *pp)",
    ),
    HidP_MaxUsageListLength: hid.func(
      "uint32 __stdcall HidP_MaxUsageListLength(int type, uint16 page, const uint8_t *pp)",
    ),
    HidP_GetUsages: hid.func(
      "int32 __stdcall HidP_GetUsages(int type, uint16 page, uint16 link, _Out_ uint16 *list, _Inout_ uint32 *len, const uint8_t *pp, const uint8_t *report, uint32 reportLen)",
    ),
    HidP_GetUsageValue: hid.func(
      "int32 __stdcall HidP_GetUsageValue(int type, uint16 page, uint16 link, uint16 usage, _Out_ uint32 *value, const uint8_t *pp, const uint8_t *report, uint32 reportLen)",
    ),
  };
  return api;
};

// Friendly name Windows shows in "Set up USB game controllers"
const oemNameCache = new Map();
const oemName = (vid, pid) => {
  const key = `${vid}&${pid}`;
  if (oemNameCache.has(key)) return oemNameCache.get(key);
  let name = null;
  try {
    const out = execSync(
      `reg query "HKCU\\System\\CurrentControlSet\\Control\\MediaProperties\\PrivateProperties\\Joystick\\OEM\\VID_${vid}&PID_${pid}" /v OEMName`,
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    ).toString();
    const m = out.match(/OEMName\s+REG_SZ\s+(.+)/);
    if (m) name = m[1].trim();
  } catch {}
  oemNameCache.set(key, name);
  return name;
};

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

// 8-way hat position -> which of up/right/down/left are held
const HAT_DIRS = [
  ["up"], ["up", "right"], ["right"], ["down", "right"],
  ["down"], ["down", "left"], ["left"], ["up", "left"],
];

class RawJoystickReader extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map(); // hDevice (string) -> parsed device info, or null if not a game controller
    this.window = null;
  }

  // window: a BrowserWindow that lives as long as the reader (it can be hidden)
  start(window) {
    if (process.platform !== "win32" || process.arch !== "x64") {
      throw new Error("Raw joystick input is only supported on 64-bit Windows");
    }
    const a = loadApi();
    this.window = window;
    const hwnd = window.getNativeWindowHandle().readBigUInt64LE(0);

    // Joystick (0x04), game pad (0x05) and multi-axis controller (0x08)
    const usages = [0x04, 0x05, 0x08];
    const rid = Buffer.alloc(usages.length * 16);
    usages.forEach((usage, i) => {
      rid.writeUInt16LE(PAGE_GENERIC, i * 16);
      rid.writeUInt16LE(usage, i * 16 + 2);
      rid.writeUInt32LE(RIDEV_INPUTSINK, i * 16 + 4);
      rid.writeBigUInt64LE(hwnd, i * 16 + 8);
    });
    if (!a.RegisterRawInputDevices(rid, usages.length, 16)) {
      throw new Error("RegisterRawInputDevices failed");
    }

    this.#enumerateDevices();

    window.hookWindowMessage(WM_INPUT, (_wParam, lParam) => {
      try {
        this.#onRawInput(lParam.readBigUInt64LE(0));
      } catch (e) {
        this.emit("error", e);
      }
    });
  }

  stop() {
    if (this.window && !this.window.isDestroyed()) {
      try {
        this.window.unhookWindowMessage(WM_INPUT);
      } catch {}
    }
    this.window = null;
  }

  // Names of the game controllers seen so far (they appear once they send input)
  listDevices() {
    return [...this.devices.values()].filter(Boolean).map((d) => ({ device: d.key, name: d.name, occ: d.occ }));
  }

  // Describe every connected game controller up front, so identical devices
  // get stable numbers (by device path) instead of first-input order.
  #enumerateDevices() {
    const a = loadApi();
    const count = [0];
    a.GetRawInputDeviceList(null, count, 16);
    if (!count[0]) return;
    const list = Buffer.alloc(count[0] * 16);
    const n = a.GetRawInputDeviceList(list, count, 16);
    if (n === 0xffffffff) return;
    for (let i = 0; i < n; i++) {
      if (list.readUInt32LE(i * 16 + 8) !== RIM_TYPEHID) continue;
      const h = list.readBigUInt64LE(i * 16);
      try {
        this.devices.set(h.toString(), this.#describeDevice(h));
      } catch (e) {
        this.emit("error", e);
      }
    }
    this.#renumber();
  }

  #renumber() {
    const byKey = new Map();
    for (const d of this.devices.values()) {
      if (!d) continue;
      if (!byKey.has(d.key)) byKey.set(d.key, []);
      byKey.get(d.key).push(d);
    }
    for (const group of byKey.values()) {
      group.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
      group.forEach((d, i) => (d.occ = i));
    }
  }

  #onRawInput(hRawInput) {
    const a = loadApi();
    const size = [0];
    a.GetRawInputData(hRawInput, RID_INPUT, null, size, RAWINPUTHEADER_SIZE);
    if (!size[0]) return;
    const buf = Buffer.alloc(size[0]);
    if (a.GetRawInputData(hRawInput, RID_INPUT, buf, size, RAWINPUTHEADER_SIZE) === 0xffffffff) return;
    if (buf.readUInt32LE(0) !== RIM_TYPEHID) return;

    const hDevice = buf.readBigUInt64LE(8);
    const dev = this.#getDevice(hDevice);
    if (!dev) return;

    const sizeHid = buf.readUInt32LE(RAWINPUTHEADER_SIZE);
    const count = buf.readUInt32LE(RAWINPUTHEADER_SIZE + 4);
    for (let i = 0; i < count; i++) {
      const start = RAWINPUTHEADER_SIZE + 8 + i * sizeHid;
      this.#onReport(dev, buf.subarray(start, start + sizeHid));
    }
  }

  #onReport(dev, report) {
    const a = loadApi();
    const reportId = dev.usesReportIds ? report[0] : 0;
    const held = new Set();

    // Buttons
    if (dev.maxButtons > 0) {
      const list = new Uint16Array(dev.maxButtons);
      const len = [dev.maxButtons];
      const st = a.HidP_GetUsages(HIDP_INPUT, PAGE_BUTTON, 0, list, len, dev.pp, report, report.length);
      if (st === HIDP_STATUS_SUCCESS) {
        for (let i = 0; i < len[0]; i++) held.add(String(list[i]));
      }
    }

    // Hats
    dev.hats.forEach((hat, idx) => {
      if (dev.usesReportIds && hat.reportId !== reportId) return;
      const value = [0];
      const st = a.HidP_GetUsageValue(HIDP_INPUT, PAGE_GENERIC, hat.link, USAGE_HAT, value, dev.pp, report, report.length);
      if (st !== HIDP_STATUS_SUCCESS) return;
      const v = value[0] | 0;
      const positions = hat.max - hat.min + 1;
      if (v < hat.min || v > hat.max || positions <= 0) return; // centred
      const dir = Math.round(((v - hat.min) * 8) / positions) % 8;
      for (const d of HAT_DIRS[dir]) held.add(`hat${idx + 1}${d}`);
    });

    // The first report from a device only records what is already held
    // (latched toggles, a resting hat), so those don't fire as presses.
    if (!dev.state.has(reportId)) {
      dev.state.set(reportId, held);
      return;
    }

    const prev = dev.state.get(reportId);
    for (const control of held) {
      if (!prev.has(control)) {
        this.emit("press", { device: dev.key, name: dev.name, occ: dev.occ, control });
      }
    }
    dev.state.set(reportId, held);
  }

  #getDevice(hDevice) {
    const k = hDevice.toString();
    if (this.devices.has(k)) return this.devices.get(k);
    let dev = null;
    try {
      dev = this.#describeDevice(hDevice);
    } catch (e) {
      this.emit("error", e);
    }
    this.devices.set(k, dev);
    // a device plugged in after start: number it among its identical siblings
    if (dev) this.#renumber();
    return dev;
  }

  #describeDevice(hDevice) {
    const a = loadApi();

    // Vendor / product id
    const info = Buffer.alloc(32);
    info.writeUInt32LE(32, 0);
    if (a.GetRawInputDeviceInfoW(hDevice, RIDI_DEVICEINFO, info, [32]) === 0xffffffff) return null;
    if (info.readUInt32LE(4) !== RIM_TYPEHID) return null;
    const vid = hex4(info.readUInt32LE(8));
    const pid = hex4(info.readUInt32LE(12));

    // Device path, used to number identical devices consistently
    const nameLen = [0];
    a.GetRawInputDeviceInfoW(hDevice, RIDI_DEVICENAME, null, nameLen);
    const nameBuf = Buffer.alloc(nameLen[0] * 2);
    a.GetRawInputDeviceInfoW(hDevice, RIDI_DEVICENAME, nameBuf, nameLen);
    const path = nameBuf.toString("utf16le").replace(/\0.*$/, "");

    // HID preparsed data
    const ppLen = [0];
    a.GetRawInputDeviceInfoW(hDevice, RIDI_PREPARSEDDATA, null, ppLen);
    if (!ppLen[0]) return null;
    const pp = Buffer.alloc(ppLen[0]);
    if (a.GetRawInputDeviceInfoW(hDevice, RIDI_PREPARSEDDATA, pp, ppLen) === 0xffffffff) return null;

    const caps = Buffer.alloc(64);
    if (a.HidP_GetCaps(pp, caps) !== HIDP_STATUS_SUCCESS) return null;
    const numButtonCaps = caps.readUInt16LE(46);
    const numValueCaps = caps.readUInt16LE(48);

    let usesReportIds = false;
    if (numButtonCaps > 0) {
      const bcaps = Buffer.alloc(72 * numButtonCaps);
      const len = [numButtonCaps];
      if (a.HidP_GetButtonCaps(HIDP_INPUT, bcaps, len, pp) === HIDP_STATUS_SUCCESS) {
        for (let i = 0; i < len[0]; i++) if (bcaps[i * 72 + 2] !== 0) usesReportIds = true;
      }
    }

    const hats = [];
    if (numValueCaps > 0) {
      const vcaps = Buffer.alloc(72 * numValueCaps);
      const len = [numValueCaps];
      if (a.HidP_GetValueCaps(HIDP_INPUT, vcaps, len, pp) === HIDP_STATUS_SUCCESS) {
        for (let i = 0; i < len[0]; i++) {
          const o = i * 72;
          if (vcaps[o + 2] !== 0) usesReportIds = true;
          const page = vcaps.readUInt16LE(o);
          const isRange = vcaps[o + 12] !== 0;
          const usage = vcaps.readUInt16LE(o + 56); // NotRange.Usage / Range.UsageMin
          if (page === PAGE_GENERIC && !isRange && usage === USAGE_HAT) {
            hats.push({
              reportId: vcaps[o + 2],
              link: vcaps.readUInt16LE(o + 6),
              min: vcaps.readInt32LE(o + 40),
              max: vcaps.readInt32LE(o + 44),
            });
          }
        }
      }
    }

    const maxButtons = a.HidP_MaxUsageListLength(HIDP_INPUT, PAGE_BUTTON, pp);
    if (maxButtons === 0 && hats.length === 0) return null;

    const key = `VID_${vid}&PID_${pid}`;

    return {
      key,
      path,
      occ: 0, // set by #renumber
      name: oemName(vid, pid) || `${key}`,
      pp,
      usesReportIds,
      maxButtons,
      hats,
      state: new Map(),
    };
  }
}

module.exports = RawJoystickReader;
