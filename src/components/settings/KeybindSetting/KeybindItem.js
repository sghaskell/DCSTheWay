import { useState } from "react";
import { useSelector } from "react-redux";
import { Button, Grid, IconButton, TextField, Typography } from "@mui/material";
import ClearIcon from "@mui/icons-material/Clear";
const { ipcRenderer } = window.require("electron");

const getByPath = (obj, path) => {
  if (!obj || !path) return undefined;

  // first try direct key match (supports "optionDialogKeybinds.op1" stored literally)
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];

  // Then try nested lookup (supports optionDialogKeybinds: { op1: ... })
  if (!path.includes(".")) return obj[path];
  return path.split(".").reduce((acc, part) => (acc ? acc[part] : undefined), obj);
};

// "JOY|VID_231D&PID_012D|0|22|S-TECS MODERN THROTTLE"
//   -> { control: "BTN22", device: "S-TECS MODERN THROTTLE" }
// "JOY|VID_346E&PID_1002|1|hat1up|MOZA AB6 FFB Base"
//   -> { control: "HAT1 UP", device: "MOZA AB6 FFB Base #2" }
export const formatJoyBinding = (binding) => {
  if (typeof binding !== "string" || !binding.startsWith("JOY|")) return null;
  const [, deviceId, occRaw, control = "", ...nameParts] = binding.split("|");
  const occ = Number(occRaw) || 0;
  const name = nameParts.join("|").trim() || deviceId || "Joystick";
  const hat = control.match(/^hat(\d+)(up|down|left|right)$/);
  return {
    control: hat ? `HAT${hat[1]} ${hat[2].toUpperCase()}` : `BTN${control}`,
    device: `${name}${occ > 0 ? ` #${occ + 1}` : ""}`,
  };
};

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const KeybindItem = ({ name, preferenceKey, joyAction, changeKeybindHandler }) => {
  const userPreferences = useSelector((state) => state.ui.userPreferences);
  const [capturing, setCapturing] = useState(false);

  const keybind = getByPath(userPreferences, preferenceKey) || "None";
  const joyKey = joyAction ? `joyBinds.${joyAction}` : null;
  const joyBinding = joyKey ? getByPath(userPreferences, joyKey) : null;
  const joyLabel = formatJoyBinding(joyBinding);

  const handleInputFocus = () => {
    ipcRenderer.send("focus");
  };
  const handleInputDefocus = (event) => {
    ipcRenderer.send("defocus");
    event.target.blur();
  };

  const handleKeyPress = (event) => {
    event.preventDefault();
    const key = event.key;
    let code = event.code;
    if (key === "Shift" || key === "Control" || key === "Alt" || event.repeat)
      return;

    if (key === "Delete") {
      changeKeybindHandler(preferenceKey, "None");
    } else {
      const ctrl = event.ctrlKey ? "CTRL+" : "";
      const shift = event.shiftKey ? "SHIFT+" : "";
      const alt = event.altKey ? "ALT+" : "";
      code = code.replace("Key", "").replace("Digit", "");
      const newKeybind = ctrl + shift + alt + code;

      changeKeybindHandler(preferenceKey, newKeybind);
    }
  };

  const handleJoyCapture = async () => {
    if (capturing) {
      ipcRenderer.send("joy:cancelCapture");
      return;
    }
    setCapturing(true);
    try {
      const binding = await ipcRenderer.invoke("joy:capture");
      if (binding) changeKeybindHandler(joyKey, binding);
    } finally {
      setCapturing(false);
    }
  };

  return (
    <Grid container sx={{ py: 0.5 }} alignItems="center" columnSpacing={1}>
      <Grid item xs={12}>
        <Typography variant="body2">{name}</Typography>
      </Grid>
      <Grid item xs={joyKey ? 4 : 12}>
        <TextField
          size="small"
          fullWidth
          InputProps={{
            readOnly: true,
          }}
          value={keybind}
          onKeyDown={handleKeyPress}
          onMouseEnter={handleInputFocus}
          onMouseLeave={handleInputDefocus}
        />
      </Grid>
      {joyKey && (
        <>
          <Grid item xs={7}>
            <Button
              size="small"
              fullWidth
              variant={capturing ? "contained" : "outlined"}
              onClick={handleJoyCapture}
              title={
                joyLabel
                  ? `${joyLabel.control} on ${joyLabel.device}`
                  : "Click, then press a joystick button"
              }
              sx={{ textTransform: "none", justifyContent: "flex-start", minWidth: 0 }}
            >
              {capturing ? (
                <span style={ellipsis}>Press a button…</span>
              ) : joyLabel ? (
                <span style={ellipsis}>
                  <strong>{joyLabel.control}</strong> {joyLabel.device}
                </span>
              ) : (
                <span style={ellipsis}>Joystick: none</span>
              )}
            </Button>
          </Grid>
          <Grid item xs={1}>
            <IconButton
              size="small"
              disabled={!joyLabel}
              onClick={() => changeKeybindHandler(joyKey, "None")}
              title="Clear joystick binding"
            >
              <ClearIcon fontSize="small" />
            </IconButton>
          </Grid>
        </>
      )}
    </Grid>
  );
};

export default KeybindItem;
