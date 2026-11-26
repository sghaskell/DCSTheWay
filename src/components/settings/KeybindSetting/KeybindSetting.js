import { Stack, Typography } from "@mui/material";
import KeybindItem from "./KeybindItem";

const ITEMS = [
  { name: "Toggle Crosshair", preferenceKey: "crosshairKeybind", joyAction: "crosshair" },
  { name: "Save Waypoint", preferenceKey: "saveKeybind", joyAction: "save" },
  { name: "Delete Last Waypoint", preferenceKey: "deleteLastKeybind", joyAction: "deleteLast" },
  { name: "Delete All Waypoints", preferenceKey: "deleteAllKeybind", joyAction: "deleteAll" },
  { name: "Transfer Waypoints", preferenceKey: "transferKeybind", joyAction: "transfer" },
  { name: "Abort Transfer", preferenceKey: "abortKeybind", joyAction: "abort" },
];

const OPTION_ITEMS = [1, 2, 3, 4].map((n) => ({
  name: `Option ${n}`,
  preferenceKey: `optionDialogKeybinds.op${n}`,
  joyAction: `op${n}`,
}));

const KeybindSetting = ({ settingChangeHandler }) => {
  return (
    <Stack direction={"column"} sx={{ width: "100%" }}>
      <Typography gutterBottom>Keybindings</Typography>
      <Typography variant="caption">
        Keyboard: click in a box, then press a key combination (Delete removes
        it). Joystick: click the button, then press a button or hat on your
        stick, throttle or button box. Button numbers match DCS (BTN22 =
        JOY_BTN22).
      </Typography>

      {ITEMS.map((item) => (
        <KeybindItem
          key={item.preferenceKey}
          {...item}
          changeKeybindHandler={settingChangeHandler}
        />
      ))}

      <Typography variant="subtitle2" sx={{ mt: 2 }}>
        Option dialog answers (shown in DCS as [1]–[4])
      </Typography>
      {OPTION_ITEMS.map((item) => (
        <KeybindItem
          key={item.preferenceKey}
          {...item}
          changeKeybindHandler={settingChangeHandler}
        />
      ))}
    </Stack>
  );
};

export default KeybindSetting;
