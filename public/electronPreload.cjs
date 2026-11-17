const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexia", {
  getState: () => ipcRenderer.invoke("codexia:get-state"),
  postEvent: (payload) => ipcRenderer.invoke("codexia:post-event", payload),
  startThreadWatch: (payload) => ipcRenderer.invoke("codexia:start-thread-watch", payload),
  stopThreadWatch: (payload) => ipcRenderer.invoke("codexia:stop-thread-watch", payload),
  getThreadProfiles: () => ipcRenderer.invoke("codexia:get-thread-profiles"),
  getSpeechVolume: () => ipcRenderer.invoke("codexia:get-speech-volume"),
  setSpeechVolume: (volume) => ipcRenderer.invoke("codexia:set-speech-volume", { volume }),
  lookupThreadName: (payload) => ipcRenderer.invoke("codexia:lookup-thread-name", payload),
  saveThreadProfile: (payload) => ipcRenderer.invoke("codexia:save-thread-profile", payload),
  setVoicevoxAcceleration: (payload) => ipcRenderer.invoke("codexia:set-voicevox-acceleration", payload),
  getFloatingOverlay: () => ipcRenderer.invoke("codexia:get-floating-overlay"),
  floatingOverlayAction: (payload) => ipcRenderer.invoke("codexia:floating-overlay-action", payload),
  getFloatingRoleVisibility: () => ipcRenderer.invoke("codexia:get-floating-role-visibility"),
  setFloatingRoleVisibility: (payload) => ipcRenderer.invoke("codexia:set-floating-role-visibility", payload),
  setFloatingInputPassthrough: (passthrough) => {
    ipcRenderer.send("codexia:set-floating-input-passthrough", Boolean(passthrough));
  },
  setFloatingWindowBounds: (bounds) => {
    ipcRenderer.send("codexia:set-floating-window-bounds", bounds);
  },
  onFitFloatingWindow: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("codexia:fit-floating-window", listener);
    return () => ipcRenderer.off("codexia:fit-floating-window", listener);
  },
  onFloatingInputPassthroughChanged: (callback) => {
    const listener = (_event, passthrough) => callback(Boolean(passthrough));
    ipcRenderer.on("codexia:floating-input-passthrough-changed", listener);
    return () => ipcRenderer.off("codexia:floating-input-passthrough-changed", listener);
  },
  onFloatingRoleVisibilityChanged: (callback) => {
    const listener = (_event, visibility) => callback(visibility);
    ipcRenderer.on("codexia:floating-role-visibility-changed", listener);
    return () => ipcRenderer.off("codexia:floating-role-visibility-changed", listener);
  },
  onSnapshot: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("codexia:snapshot", listener);
    return () => ipcRenderer.off("codexia:snapshot", listener);
  },
});
