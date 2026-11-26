import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  FormControlLabel,
  Stack,
  Typography,
} from "@mui/material";

const { ipcRenderer } = window.require("electron");

const describe = (install) => {
  if (install.error) return { text: `error: ${install.error}`, color: "error.main" };
  if (!install.filesInstalled) return { text: "not installed", color: "text.secondary" };
  if (install.exportState === "disabled")
    return { text: "TheWay line is commented out in Export.lua", color: "warning.main" };
  if (install.exportState !== "active")
    return { text: "missing from Export.lua", color: "warning.main" };
  if (!install.filesCurrent) return { text: "files out of date", color: "warning.main" };
  if (install.changedThisRun)
    return { text: "updated - takes effect next mission", color: "success.main" };
  return { text: "installed", color: "success.main" };
};

const DcsSetupSetting = () => {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ipcRenderer.invoke("dcs:status").then(setStatus).catch(() => {});
  }, []);

  const run = (channel, arg) => {
    setBusy(true);
    ipcRenderer
      .invoke(channel, arg)
      .then(setStatus)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  return (
    <Stack direction={"column"} sx={{ width: "100%" }}>
      <Typography gutterBottom>DCS setup</Typography>
      {status && status.installs.length === 0 && (
        <Typography variant="caption" color="warning.main">
          No DCS folder found in {status.savedGames}. Start DCS once, then
          reopen TheWay.
        </Typography>
      )}
      {status?.installs.map((install) => {
        const d = describe(install);
        return (
          <Typography key={install.dir} variant="caption">
            {install.name}:{" "}
            <Typography component="span" variant="caption" color={d.color}>
              {d.text}
            </Typography>
          </Typography>
        );
      })}
      <FormControlLabel
        control={
          <Checkbox
            checked={status?.auto !== false}
            disabled={!status || busy}
            onChange={(e) => run("dcs:setAuto", e.target.checked)}
          />
        }
        label={"Keep DCS files up to date"}
      />
      <Stack direction={"row"} spacing={1}>
        <Button
          size="small"
          variant="outlined"
          disabled={!status || busy}
          onClick={() => run("dcs:install")}
        >
          Repair
        </Button>
        <Button
          size="small"
          variant="outlined"
          color="warning"
          disabled={!status || busy}
          onClick={() => run("dcs:remove")}
        >
          Remove
        </Button>
      </Stack>
    </Stack>
  );
};

export default DcsSetupSetting;
