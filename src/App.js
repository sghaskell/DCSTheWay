import {
  Box,
  createTheme,
  CssBaseline,
  ThemeProvider,
} from "@mui/material";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import ModalContainer from "react-modal-promise";

import SourceSelector from "./components/SourceSelector";
import WaypointList from "./components/waypoints/WaypointList";
import TransferControls from "./components/TransferControls";
import TitleBar from "./components/TitleBar";
import SettingsDialog from "./components/settings/SettingsDialog";
import UnitImportDialog from "./components/UnitImportDialog";

import theWayTheme from "./theme/TheWayTheme";
import ConvertModuleWaypoints from "./utils/ConvertModuleWaypoints";
import GetModuleCommands from "./moduleCommands/GetModuleCommands";
import GetTransferCommands from "./moduleTransfers/GetTransferCommands";
import askUserAboutSeat from "./moduleCommands/askUserAboutSeat";
import useElectronIpcListeners from "./hooks/useElectronIpcListeners";
import { uiActions } from "./store/ui";
import { dcsStatus, notify, playCue } from "./utils/vrFeedback";

const { ipcRenderer } = window.require("electron");

const isUnitImportWindow =
  new URLSearchParams(window.location.search).get("window") === "unitImport";

const theme = createTheme(theWayTheme);

function App() {
  const { module } = useSelector((state) => state.dcsPoint);
  const dcsWaypoints = useSelector((state) => state.waypoints.dcsWaypoints);
  const userPreferences = useSelector((state) => state.ui.userPreferences);

  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [inputMethod, setInputMethod] = useState("F10 Map");
  const [isSelecting, setIsSelecting] = useState(false);
  const [transferRunning, setTransferRunning] = useState(false);
  const [transferAborting, setTransferAborting] = useState(false);
  const [activeTransferModule, setActiveTransferModule] = useState(null);
  const abortRequestedRef = useRef(false);
  const pendingDoneCueRef = useRef(false);
  const sawBusyRef = useRef(false);

  const buttonExtraDelay = userPreferences["buttonDelay"] ?? 0;
  const oldCrosshair = userPreferences["oldCrosshair"];

  const dispatch = useDispatch();
  useElectronIpcListeners();

  // Main window: defocus when mouse leaves
  useEffect(() => {
    if (isUnitImportWindow) return;

    let leaveTimer = null;

    const handleMouseLeave = () => {
      if (leaveTimer) window.clearTimeout(leaveTimer);
      leaveTimer = window.setTimeout(() => {
        ipcRenderer.send("defocus");
      }, 50);
    };

    const handleMouseEnter = () => {
      if (leaveTimer) {
        window.clearTimeout(leaveTimer);
        leaveTimer = null;
      }
    };

    window.addEventListener("mouseleave", handleMouseLeave);
    window.addEventListener("mouseenter", handleMouseEnter);

    return () => {
      window.removeEventListener("mouseleave", handleMouseLeave);
      window.removeEventListener("mouseenter", handleMouseEnter);
      if (leaveTimer) window.clearTimeout(leaveTimer);
    };
  }, []);

  // Unit import window: defocus/hide when mouse leaves
  useEffect(() => {
    if (!isUnitImportWindow) return;

    let leaveTimer = null;

    const handleMouseLeave = () => {
      if (leaveTimer) window.clearTimeout(leaveTimer);
      leaveTimer = window.setTimeout(() => {
        ipcRenderer.send("unitImport:defocus");
      }, 50);
    };

    const handleMouseEnter = () => {
      if (leaveTimer) {
        window.clearTimeout(leaveTimer);
        leaveTimer = null;
      }
    };

    window.addEventListener("mouseleave", handleMouseLeave);
    window.addEventListener("mouseenter", handleMouseEnter);

    return () => {
      window.removeEventListener("mouseleave", handleMouseLeave);
      window.removeEventListener("mouseenter", handleMouseEnter);
      if (leaveTimer) window.clearTimeout(leaveTimer);
    };
  }, []);

 const handleTransfer = useCallback(async () => {
  if (!module) {
    notify("error", "TheWay: not connected - enter a cockpit first", 3000, "Not connected. Enter a cockpit first.");
    return;
  }
  if (!dcsWaypoints.length) {
    notify("error", "TheWay: no waypoints to transfer", 3000, "No waypoints to transfer.");
    return;
  }

  setTransferAborting(false);
  abortRequestedRef.current = false;
  pendingDoneCueRef.current = false;
  sawBusyRef.current = false;

  const moduleWaypoints = ConvertModuleWaypoints(dcsWaypoints, module);
  const chosenSeat = await askUserAboutSeat(module, userPreferences);
  const transferModule = GetTransferCommands(chosenSeat);

  notify(
    "transferStart",
    `TheWay: transferring ${dcsWaypoints.length} waypoint${
      dcsWaypoints.length === 1 ? "" : "s"
    }...`,
    20000, // replaced by progress / "complete"; expires if the transfer never starts
    `Transferring ${dcsWaypoints.length} waypoint${dcsWaypoints.length === 1 ? "" : "s"}.`,
  );

  if (transferModule?.runTransfer) {
    setTransferRunning(true);
    setActiveTransferModule(chosenSeat);

    try {
      await transferModule.runTransfer({
        module: chosenSeat,
        moduleWaypoints,
        buttonExtraDelay,
        ipcRenderer,
        setRunning: setTransferRunning,
      });
      if (!abortRequestedRef.current) {
        notify("transferDone", "TheWay: transfer complete", 3000, "Transfer complete.");
      }
    } catch (err) {
      if (!abortRequestedRef.current) {
        console.log("[TheWay] transfer failed:", err);
        notify("error", "TheWay: transfer failed", 5000, "Transfer failed.");
      }
    } finally {
      setTransferRunning(false);
      setTransferAborting(false);
      setActiveTransferModule(null);
    }
    return;
  }

  setTransferRunning(false);
  setActiveTransferModule(null);

  // TheWay.lua shows progress and "transfer complete" itself for this path
  ipcRenderer.send("messageToDcs", {
    type: "waypoints",
    announce: true,
    payload: GetModuleCommands(chosenSeat, moduleWaypoints, buttonExtraDelay),
  });
  pendingDoneCueRef.current = true;
}, [dcsWaypoints, module, userPreferences, buttonExtraDelay]);

  // Play the "done" cue for single-shot transfers when DCS reports it is no
  // longer busy (the text is shown by TheWay.lua).
  const dcsBusy = useSelector((state) => state.dcsPoint.busy);
  useEffect(() => {
    if (!pendingDoneCueRef.current) return;
    if (dcsBusy === true) {
      sawBusyRef.current = true;
    } else if (sawBusyRef.current) {
      pendingDoneCueRef.current = false;
      sawBusyRef.current = false;
      if (!abortRequestedRef.current) playCue("transferDone", { say: "Transfer complete." });
    }
  }, [dcsBusy]);

  const handleAbort = useCallback(() => {
  abortRequestedRef.current = true;
  pendingDoneCueRef.current = false;
  sawBusyRef.current = false;
  playCue("abort", { say: "Transfer aborted." });
  if (activeTransferModule) {
    setTransferAborting(true);

    const transferModule = GetTransferCommands(activeTransferModule);
    transferModule?.requestAbort?.();
  }

  ipcRenderer.send("messageToDcs", { type: "abort" });
  dcsStatus("TheWay: transfer aborted", 3000);

  if (!activeTransferModule) {
    setTransferRunning(false);
    setTransferAborting(false);
    setActiveTransferModule(null);
  }
}, [activeTransferModule]);

  const handleFileSave = useCallback(() => {
    ipcRenderer.send("saveFile", JSON.stringify(dcsWaypoints));
  }, [dcsWaypoints]);

  // Which crosshair is actually showing: "old" (desktop window), "dcs" (drawn
  // by TheWay.lua) or null. Hiding uses this, not the current setting, so
  // changing "Old style crosshair" while it's on can't leave one stuck.
  const activeCrosshairRef = useRef(null);

  const showCrosshair = useCallback((kind) => {
    if (kind === "old") {
      ipcRenderer.send("f10Start");
    } else {
      ipcRenderer.send("messageToDcs", { type: "crosshair", payload: "true" });
    }
    activeCrosshairRef.current = kind;
  }, []);

  const hideCrosshair = useCallback(() => {
    if (activeCrosshairRef.current === "old") {
      ipcRenderer.send("f10Stop");
    } else if (activeCrosshairRef.current === "dcs") {
      ipcRenderer.send("messageToDcs", { type: "crosshair", payload: "false" });
    }
    activeCrosshairRef.current = null;
  }, []);

  // Switch crosshairs live when the setting changes while one is showing
  useEffect(() => {
    const wanted = oldCrosshair ? "old" : "dcs";
    if (activeCrosshairRef.current && activeCrosshairRef.current !== wanted) {
      hideCrosshair();
      showCrosshair(wanted);
    }
  }, [oldCrosshair, showCrosshair, hideCrosshair]);

  const handleSelectionToggle = useCallback(() => {
    if (!isSelecting) {
      if (inputMethod === "F10 Map") {
        showCrosshair(oldCrosshair ? "old" : "dcs");

        dispatch(uiActions.changePendingWaypoint(true));
        setIsSelecting(true);
        notify("crosshairOn", "TheWay: crosshair ON - " + dcsWaypoints.length + " WP", 2000, "Crosshair on.");
      } else if (inputMethod === "From a file") {
        ipcRenderer.send("openFile");
      } else if (inputMethod === "Recon Request") {
        ipcRenderer.send("openUnitImport");
      }
    } else {
      if (inputMethod === "F10 Map") {
        hideCrosshair();

        dispatch(uiActions.changePendingWaypoint(false));
        setIsSelecting(false);
        notify("crosshairOff", "TheWay: crosshair OFF - " + dcsWaypoints.length + " WP", 2000, "Crosshair off.");
      }
    }
  }, [dispatch, inputMethod, isSelecting, oldCrosshair, dcsWaypoints.length, showCrosshair, hideCrosshair]);

  useEffect(() => {
    ipcRenderer.on("transferWaypoints", handleTransfer);
    ipcRenderer.on("toggleCrosshair", handleSelectionToggle);
    ipcRenderer.on("abortTransfer", handleAbort);

    return () => {
      ipcRenderer.removeAllListeners("abortTransfer");
      ipcRenderer.removeAllListeners("transferWaypoints");
      ipcRenderer.removeAllListeners("toggleCrosshair");
    };
  }, [handleTransfer, handleSelectionToggle, handleAbort]);

  if (isUnitImportWindow) {
    return (
      <ThemeProvider theme={theme}>
        <CssBaseline enableColorScheme />
        <UnitImportDialog
          open={true}
          onClose={() => ipcRenderer.send("closeUnitImport")}
          standalone
        />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme />
      <TitleBar openSettingsHandler={() => setSettingsModalOpen(true)} />
      <ModalContainer />

      <Box sx={{ height: "100vh" }}>
        <SettingsDialog
          open={settingsModalOpen}
          closeHandler={() => setSettingsModalOpen(false)}
        />

        <Box sx={{ height: "25%" }}>
          <SourceSelector
            handleSelectionToggle={handleSelectionToggle}
            module={module}
            inputMethod={inputMethod}
            setInputMethod={setInputMethod}
            isSelecting={isSelecting}
          />
        </Box>

        <Box sx={{ height: "60%", paddingX: 2 }}>
          <WaypointList />
        </Box>

        <Box sx={{ height: "15%" }}>
          <TransferControls
            transferRunning={transferRunning}
            transferAborting={transferAborting}
            onTransfer={handleTransfer}
            onAbort={handleAbort}
            onSaveFile={handleFileSave}
          />
        </Box>
      </Box>
    </ThemeProvider>
  );
}

export default App;