import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormGroup,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useSelector } from "react-redux";
import { audioMode, dcsStatus, playCue } from "../../utils/vrFeedback";

const { ipcRenderer } = window.require("electron");

const RATES = [
  { label: "Normal", value: 1 },
  { label: "Fast", value: 3 },
  { label: "Faster", value: 5 },
];

// "Microsoft Zira Desktop" -> "Zira"
const shortVoiceName = (v) => v.replace(/^Microsoft\s+/, "").replace(/\s+Desktop$/, "");

const VrFeedbackSetting = ({ settingChangeHandler }) => {
  const userPreferences = useSelector((state) => state.ui.userPreferences);
  const mode = audioMode();
  const [voices, setVoices] = useState([]);

  useEffect(() => {
    if (mode !== "voice" || voices.length) return;
    let cancelled = false;
    ipcRenderer
      .invoke("speech:voices")
      .then((v) => {
        if (!cancelled) setVoices(Array.isArray(v) ? v : []);
      })
      .catch((e) => console.log("[TheWay] speech voices unavailable:", e));
    return () => {
      cancelled = true;
    };
  }, [mode, voices.length]);

  const voice = userPreferences["speechVoice"] || "";
  const rate = Number(userPreferences["speechRate"] ?? 1);

  return (
    <Stack direction={"column"} spacing={1} sx={{ width: "100%" }}>
      <Typography>VR feedback</Typography>

      <Typography variant="caption">Audio cues</Typography>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={mode}
        onChange={(_e, v) => v && settingChangeHandler("audioCues", v)}
      >
        <ToggleButton value="off">Off</ToggleButton>
        <ToggleButton value="tones">Tones</ToggleButton>
        <ToggleButton value="voice">Voice</ToggleButton>
      </ToggleButtonGroup>

      {mode === "voice" && (
        <>
          <FormControl size="small" fullWidth>
            <InputLabel shrink>Voice</InputLabel>
            <Select
              label="Voice"
              notched
              displayEmpty
              value={voices.includes(voice) ? voice : ""}
              renderValue={(v) => (v ? shortVoiceName(v) : "Windows default")}
              onChange={(e) => settingChangeHandler("speechVoice", e.target.value)}
            >
              <MenuItem value="">Windows default</MenuItem>
              {voices.map((v) => (
                <MenuItem key={v} value={v}>
                  {shortVoiceName(v)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Typography variant="caption">Speed</Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={rate}
            onChange={(_e, v) => v != null && settingChangeHandler("speechRate", v)}
          >
            {RATES.map((r) => (
              <ToggleButton key={r.value} value={r.value}>
                {r.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <FormControlLabel
            control={
              <Checkbox
                checked={userPreferences["speechRadio"] !== false}
                onChange={(e) => settingChangeHandler("speechRadio", e.target.checked)}
              />
            }
            label={"Radio effect (squelch)"}
          />
        </>
      )}

      <FormGroup>
        <FormControlLabel
          control={
            <Checkbox
              checked={userPreferences["dcsStatusText"] !== false}
              onChange={(e) =>
                settingChangeHandler("dcsStatusText", e.target.checked)
              }
            />
          }
          label={"Status text inside DCS"}
        />
      </FormGroup>
      <Button
        size="small"
        variant="outlined"
        sx={{ alignSelf: "flex-start" }}
        onClick={() => {
          playCue("crosshairOn", {
            say: "Crosshair on.",
            mode: mode === "off" ? "tones" : mode,
          });
          dcsStatus("TheWay: test message", 3000);
        }}
      >
        Test
      </Button>
    </Stack>
  );
};

export default VrFeedbackSetting;
