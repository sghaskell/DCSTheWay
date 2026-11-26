import {
  Box,
  Checkbox,
  FormControlLabel,
  FormGroup,
  Stack,
  Typography,
} from "@mui/material";
import { MuiColorInput } from "mui-color-input";
import _ from "lodash";
import { useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import "./SettingsDialog.css";

const CrosshairSetting = ({ settingChangeHandler }) => {
  const userPreferences = useSelector((state) => state.ui.userPreferences);
  const oldCrosshair = userPreferences["oldCrosshair"];
  const userPreferenceColor = userPreferences["crosshairColor"];

  const [crosshairColor, setCrosshairColor] = useState("#7CFC00FF");
  useEffect(() => {
    const color = userPreferenceColor;
    if (color) setCrosshairColor(color);
  }, [userPreferenceColor]);

  // Save (and recolor the open crosshair) at most every 150 ms while dragging.
  // Created once: a debounce rebuilt on every render never actually debounces.
  const saveColor = useMemo(
    () => _.debounce((color) => settingChangeHandler("crosshairColor", color), 150),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => saveColor.flush(), [saveColor]);

  return (
    <Stack direction={"column"}>
      <Typography id="crosshair-color" gutterBottom sx={{ m: 0 }}>
        Crosshair options
      </Typography>

      <Stack direction="column" spacing={1}>
        <FormGroup>
          <FormControlLabel
            control={
              <Checkbox
                checked={oldCrosshair}
                onChange={(e) =>
                  settingChangeHandler("oldCrosshair", e.target.checked)
                }
              />
            }
            label={"Old style crosshair"}
          />
          <Typography variant="caption">
            The old crosshair has customizable colors, but does not show in VR
            or work correctly with multiple monitors.
          </Typography>
        </FormGroup>
        {oldCrosshair && (
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2">Color</Typography>
            <Box sx={{ width: "100%" }}>
              <MuiColorInput
                value={crosshairColor}
                onChange={(color) => {
                  setCrosshairColor(color); // the picker follows the mouse at once
                  saveColor(color);
                }}
                format="hex"
                isAlphaHidden
              />
            </Box>
          </Stack>
        )}
      </Stack>
    </Stack>
  );
};

export default CrosshairSetting;
