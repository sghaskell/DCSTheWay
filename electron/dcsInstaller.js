// Installs TheWay's DCS-side files so users don't have to copy folders or edit
// Export.lua by hand. On every app start it finds each DCS install under Saved
// Games, copies any TheWay files that are missing or out of date into
// Scripts\TheWay, and adds the TheWay line to Scripts\Export.lua if it's absent.
// Other tools' lines in Export.lua (SRS, Tacview, DCS-BIOS, ...) are never touched.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, ipcMain } = require("electron");
const Store = require("electron-store");

const FILES = ["TheWay.lua", "TheWayStatus.dlg", "Crosshair.dlg", "Crosshair.png"];
const EXPORT_MARKER = "-- TheWay";
const EXPORT_LINE =
  "pcall(function() local TheWayLfs=require('lfs');dofile(TheWayLfs.writedir()..'Scripts/TheWay/TheWay.lua'); end)";
const THEWAY_LINE_RE = /Scripts[\\/]+TheWay[\\/]+TheWay\.lua/i;
const BACKUP_SUFFIX = ".theway-backup";

// Folder that holds the files to install: next to the app when packaged
// (electron-builder extraResources), the repo's dcsFiles folder in dev.
const sourceDir = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, "dcsFiles")
    : path.join(__dirname, "..", "dcsFiles");

// The real Saved Games folder, which users can move (e.g. into OneDrive).
const FOLDERID_SavedGames = "4C5C32FF-BB9D-43b0-B5B4-2D72E54EAAA4";
let savedGamesCache = null;
const savedGamesDir = () => {
  if (savedGamesCache) return savedGamesCache;
  try {
    const koffi = require("koffi");
    const GUID = koffi.struct("TheWayGUID", {
      Data1: "uint32",
      Data2: "uint16",
      Data3: "uint16",
      Data4: koffi.array("uint8", 8),
    });
    const shell32 = koffi.load("shell32.dll");
    const ole32 = koffi.load("ole32.dll");
    const SHGetKnownFolderPath = shell32.func(
      "int __stdcall SHGetKnownFolderPath(const TheWayGUID *rfid, uint32 flags, void *token, _Out_ void **path)",
    );
    const CoTaskMemFree = ole32.func("void __stdcall CoTaskMemFree(void *pv)");
    const hex = FOLDERID_SavedGames.replace(/-/g, "");
    const guid = {
      Data1: parseInt(hex.slice(0, 8), 16),
      Data2: parseInt(hex.slice(8, 12), 16),
      Data3: parseInt(hex.slice(12, 16), 16),
      Data4: Array.from({ length: 8 }, (_, i) => parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16)),
    };
    const out = [null];
    if (SHGetKnownFolderPath(guid, 0, null, out) === 0 && out[0]) {
      const dir = koffi.decode(out[0], "char16_t", -1);
      CoTaskMemFree(out[0]);
      if (dir) return (savedGamesCache = dir);
    }
  } catch (e) {
    console.log(`[TheWay] Saved Games lookup failed, using default: ${e.message}`);
  }
  return (savedGamesCache = path.join(os.homedir(), "Saved Games"));
};

// DCS write dirs: "DCS", "DCS.openbeta", "DCS.openalpha", "DCS.server", ...
// A folder only counts once DCS has created its Config folder in it.
const findDcsDirs = (base = savedGamesDir()) => {
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^DCS(\..+)?$/i.test(e.name))
    .map((e) => path.join(base, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, "Config")));
};

const sameFile = (a, b) => {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
};

// "active": an uncommented TheWay line exists; "disabled": only commented out
// (the user turned it off, so leave it alone); "missing": no TheWay line.
const exportLineState = (text) => {
  let state = "missing";
  for (const line of text.split(/\r?\n/)) {
    if (!THEWAY_LINE_RE.test(line)) continue;
    if (/^\s*--/.test(line)) state = state === "active" ? state : "disabled";
    else state = "active";
  }
  return state;
};

const readExport = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const writeExport = (file, oldText, newText) => {
  if (oldText !== null) fs.writeFileSync(file + BACKUP_SUFFIX, oldText);
  fs.writeFileSync(file, newText);
};

// Bring one DCS folder up to date. Returns what it found and what it changed.
const installInto = (dcsDir, src = sourceDir()) => {
  const result = { dir: dcsDir, name: path.basename(dcsDir), updatedFiles: [], exportAdded: false };
  const scripts = path.join(dcsDir, "Scripts");
  const target = path.join(scripts, "TheWay");
  fs.mkdirSync(target, { recursive: true });

  for (const f of FILES) {
    const from = path.join(src, f);
    const to = path.join(target, f);
    if (!fs.existsSync(from)) throw new Error(`missing bundled file ${f}`);
    if (!sameFile(from, to)) {
      fs.copyFileSync(from, to);
      result.updatedFiles.push(f);
    }
  }

  const exportFile = path.join(scripts, "Export.lua");
  const text = readExport(exportFile);
  result.exportState = text === null ? "missing" : exportLineState(text);
  if (result.exportState === "missing") {
    const old = text ?? "";
    const eol = old.includes("\r\n") ? "\r\n" : "\n";
    const sep = old === "" || old.endsWith("\n") ? "" : eol;
    writeExport(exportFile, text, `${old}${sep}${old ? eol : ""}${EXPORT_MARKER}${eol}${EXPORT_LINE}${eol}`);
    result.exportAdded = true;
    result.exportState = "active";
  }
  return result;
};

// Undo installInto: drop TheWay's Export.lua line (and our marker comment) and
// delete the files we installed. Other files and lines are left as they were.
const removeFrom = (dcsDir) => {
  const scripts = path.join(dcsDir, "Scripts");
  const exportFile = path.join(scripts, "Export.lua");
  const text = readExport(exportFile);
  if (text !== null) {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const kept = lines.filter(
      (line, i) =>
        !THEWAY_LINE_RE.test(line) &&
        !(line.trim() === EXPORT_MARKER && THEWAY_LINE_RE.test(lines[i + 1] || "")),
    );
    if (kept.length !== lines.length) {
      // also drop the blank separator line(s) the install put before our block
      while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
      writeExport(exportFile, text, kept.length ? kept.join(eol) + eol : "");
    }
  }
  const target = path.join(scripts, "TheWay");
  for (const f of FILES) fs.rmSync(path.join(target, f), { force: true });
  try {
    fs.rmdirSync(target); // only succeeds when nothing else is left in it
  } catch {}
};

// Status of one DCS folder without changing anything.
const inspect = (dcsDir, src = sourceDir()) => {
  const target = path.join(dcsDir, "Scripts", "TheWay");
  const text = readExport(path.join(dcsDir, "Scripts", "Export.lua"));
  const outdated = FILES.filter((f) => !sameFile(path.join(src, f), path.join(target, f)));
  return {
    dir: dcsDir,
    name: path.basename(dcsDir),
    filesCurrent: outdated.length === 0,
    filesInstalled: fs.existsSync(path.join(target, "TheWay.lua")),
    exportState: text === null ? "missing" : exportLineState(text),
  };
};

class DcsInstaller {
  constructor() {
    this.store = new Store();
    this.lastRun = []; // results of the most recent install pass, per folder

    ipcMain.handle("dcs:status", () => this.status());
    ipcMain.handle("dcs:install", () => {
      this.store.set("dcsAutoInstall", true);
      this.installAll();
      return this.status();
    });
    ipcMain.handle("dcs:remove", () => {
      this.store.set("dcsAutoInstall", false);
      for (const dir of findDcsDirs()) {
        try {
          removeFrom(dir);
        } catch (e) {
          console.log(`[TheWay] removing from ${dir} failed: ${e.message}`);
        }
      }
      this.lastRun = [];
      return this.status();
    });
    ipcMain.handle("dcs:setAuto", (_e, on) => {
      this.store.set("dcsAutoInstall", on === true);
      if (on === true) this.installAll();
      return this.status();
    });

    if (this.store.get("dcsAutoInstall") !== false) this.installAll();
  }

  installAll() {
    this.lastRun = findDcsDirs().map((dir) => {
      try {
        const r = installInto(dir);
        if (r.updatedFiles.length || r.exportAdded) {
          console.log(
            `[TheWay] DCS setup in ${dir}: files ${r.updatedFiles.join(", ") || "current"}` +
              (r.exportAdded ? ", added Export.lua line" : ""),
          );
        }
        return r;
      } catch (e) {
        console.log(`[TheWay] DCS setup in ${dir} failed: ${e.message}`);
        return { dir, name: path.basename(dir), error: e.message };
      }
    });
  }

  status() {
    const ran = new Map(this.lastRun.map((r) => [r.dir, r]));
    return {
      auto: this.store.get("dcsAutoInstall") !== false,
      savedGames: savedGamesDir(),
      installs: findDcsDirs().map((dir) => {
        const r = ran.get(dir);
        let s;
        try {
          s = inspect(dir);
        } catch (e) {
          s = { dir, name: path.basename(dir), error: e.message };
        }
        return {
          ...s,
          error: s.error || r?.error,
          changedThisRun: !!(r && (r.updatedFiles?.length || r.exportAdded)),
        };
      }),
    };
  }
}

module.exports = DcsInstaller;
module.exports._test = { installInto, removeFrom, inspect, findDcsDirs, exportLineState, savedGamesDir, FILES };
