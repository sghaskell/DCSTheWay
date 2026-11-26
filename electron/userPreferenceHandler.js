const { ipcMain } = require("electron");
const Store = require("electron-store");

class userPreferenceHandler {
  mainWindow;
  applyElectronPreferences;
  store;

  constructor(mainWindow, applyElectronPreferences) {
    this.store = new Store();
    this.mainWindow = mainWindow;
    this.applyElectronPreferences = applyElectronPreferences;

    ipcMain.on("saveModulePreferences", (e, data) => {
      this.#writeModulePreferencesFile(data);
    });

    ipcMain.on("saveSettingsPreferences", (e, data) => {
      console.log("[TheWay] saveSettingsPreferences received:", data);
      this.#writeSettingsPreferencesFile(data);
    });

    ipcMain.on("getPreferences", () => {
      this.#readPreferencesFile();
    });
  }

  #writeModulePreferencesFile(data) {
    this.store.set(data.module, [data.option]);
  }

  #writeSettingsPreferencesFile(data) {
    if (typeof data.key === "string" && data.key.includes(".")) {
      const [parentKey, childKey] = data.key.split(".", 2);

      const existingParent = this.store.get(parentKey);
      const safeParent =
        existingParent && typeof existingParent === "object"
          ? existingParent
          : {};

      this.store.set(parentKey, {
        ...safeParent,
        [childKey]: data.value,
      });
    } else {
      this.store.set(data.key, data.value);
    }

    if (data.apply) {
      // Apply the full stored preferences: applying only the changed key used
      // to rebuild the hotkeys from that one key and drop every other binding.
      this.applyElectronPreferences(this.store.get());
    }
  }

  #readPreferencesFile() {
    const preferences = this.store.get();
    this.applyElectronPreferences(preferences);
    this.mainWindow.webContents.send("preferencesReceived", preferences);
  }
}

module.exports = userPreferenceHandler;
