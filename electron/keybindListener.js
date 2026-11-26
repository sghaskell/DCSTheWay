const { uIOhook, UiohookKey } = require("uiohook-napi");

// Every action that can be bound to a keyboard key or a joystick button.
// prefKey: where the keyboard binding is stored. joyKey: child key under
// "joyBinds" where the joystick binding is stored.
const ACTIONS = [
  { name: "crosshair", prefKey: "crosshairKeybind", channel: ["toggleCrosshair"] },
  { name: "save", prefKey: "saveKeybind", channel: ["saveWaypoint"] },
  { name: "deleteLast", prefKey: "deleteLastKeybind", channel: ["deleteLastWaypoint"] },
  { name: "deleteAll", prefKey: "deleteAllKeybind", channel: ["deleteWaypoints"] },
  { name: "transfer", prefKey: "transferKeybind", channel: ["transferWaypoints"] },
  { name: "abort", prefKey: "abortKeybind", channel: ["abortTransfer"] },
  { name: "op1", prefKey: "optionDialogKeybinds.op1", channel: ["optionDialogSelect", "op1"] },
  { name: "op2", prefKey: "optionDialogKeybinds.op2", channel: ["optionDialogSelect", "op2"] },
  { name: "op3", prefKey: "optionDialogKeybinds.op3", channel: ["optionDialogSelect", "op3"] },
  { name: "op4", prefKey: "optionDialogKeybinds.op4", channel: ["optionDialogSelect", "op4"] },
];

const runAction = (mainWindow, actionName) => {
  const action = ACTIONS.find((a) => a.name === actionName);
  if (!action || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(...action.channel);
};

const getPref = (preferences, path) => {
  if (!preferences) return undefined;
  if (Object.prototype.hasOwnProperty.call(preferences, path)) return preferences[path];
  return path.split(".").reduce((acc, part) => (acc ? acc[part] : undefined), preferences);
};

const parseKeybind = (keybindValue) => {
  if (!keybindValue || keybindValue === "None") return null;

  const keys = keybindValue.split("+");
  const isCtrl = keys.includes("CTRL");
  const isShift = keys.includes("SHIFT");
  const isAlt = keys.includes("ALT");
  const key = keys.at(-1);

  const keycode = UiohookKey[key];
  if (typeof keycode !== "number") return null;

  return { isCtrl, isShift, isAlt, keycode };
};

const setupKeybinds = (mainWindow, preferences) => {
  const bindings = [];

  for (const action of ACTIONS) {
    const parsed = parseKeybind(getPref(preferences, action.prefKey));
    if (parsed) bindings.push({ name: action.name, ...parsed });
  }

  // Remove any previous listeners (important if setupKeybinds is called more than once)
  uIOhook.removeAllListeners("keydown");
  uIOhook.removeAllListeners("keyup");

  // The key that triggered the last action. Auto-repeat of that key is ignored
  // until it is released; releasing some other key no longer re-arms it.
  let heldKeycode = null;

  uIOhook.on("keydown", (event) => {
    if (heldKeycode === event.keycode) return;

    for (const b of bindings) {
      if (
        event.ctrlKey === b.isCtrl &&
        event.shiftKey === b.isShift &&
        event.altKey === b.isAlt &&
        event.keycode === b.keycode
      ) {
        heldKeycode = event.keycode;
        runAction(mainWindow, b.name);
        break;
      }
    }
  });

  uIOhook.on("keyup", (event) => {
    if (event.keycode === heldKeycode) heldKeycode = null;
  });

  // Restart hook cleanly
  try {
    uIOhook.stop();
  } catch (_) {}
  uIOhook.start();
};

module.exports = setupKeybinds;
module.exports.ACTIONS = ACTIONS;
module.exports.runAction = runAction;
