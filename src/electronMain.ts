import { app, BrowserWindow, ipcMain, Menu, screen } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ElectronRuntime } from "./electronRuntime.js";
import { readCodexThreadNameFromIndex } from "./codexThreadName.js";
import type { ElectronRuntimeSnapshot } from "./electronRuntime.js";
import { FloatingRendererHealth, ManualFloatingRecovery, type FloatingDiagnosticEvent } from "./floatingRendererHealth.js";
import { RendererDiagnostics, rendererMemorySummary, windowsCommitMemory } from "./rendererDiagnostics.js";
import { floatingOverlaySettingsPath } from "./paths.js";
import { startVoiceExportServer } from "./voiceExportServer.js";

type FloatingWindowRole = "avatar" | "subtitle";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(__dirname, "..");
const publicDir = join(projectRoot, "public");
const preloadPath = join(publicDir, "electronPreload.cjs");
const floatingWindowRoles: readonly FloatingWindowRole[] = ["avatar", "subtitle"];

let mainWindow: BrowserWindow | null = null;
let floatingAvatarWindow: BrowserWindow | null = null;
let floatingSubtitleWindow: BrowserWindow | null = null;
const floatingInputPassthrough = new Map<FloatingWindowRole, boolean>();
const lastFloatingBounds = new Map<FloatingWindowRole, Electron.Rectangle>();
const completedInitialFloatingFit = new Set<FloatingWindowRole>();
const floatingRoleVisibility: Record<FloatingWindowRole, boolean> = {
  avatar: true,
  subtitle: true,
};
const runtime = new ElectronRuntime();
let voiceExportServer: Server | null = null;
const rendererDiagnostics = new RendererDiagnostics(join(projectRoot, "logs", "renderer-health"));
const manualFloatingRecovery = new ManualFloatingRecovery();
let pendingCommitSample: Promise<Record<string, number>> | null = null;
const floatingRendererHealth = new FloatingRendererHealth({
  onChange: () => publishFloatingRendererHealth(),
  onDiagnostic: (event) => logRendererDiagnostic(event),
});

function publishFloatingRendererHealth(): void {
  const health = floatingRendererHealth.snapshot();
  for (const role of floatingWindowRoles) health[role].visible = getFloatingWindow(role)?.isVisible() ?? false;
  runtime.setFloatingRendererHealth(health);
}

function logRendererDiagnostic(event: FloatingDiagnosticEvent | { kind: string; role: "gpu" | "main"; reason: string; exitCode: number }): void {
  const roleWindow = event.role === "avatar" || event.role === "subtitle" ? getFloatingWindow(event.role) : mainWindow;
  let context: Record<string, unknown>;
  try {
    context = {
      appUptimeSeconds: Math.round(process.uptime()),
      memory: rendererMemorySummary(),
      bounds: roleWindow && !roleWindow.isDestroyed() ? roleWindow.getBounds() : null,
      displays: app.isReady() ? screen.getAllDisplays().map(display => ({ id: display.id, workArea: display.workArea })) : [],
      processes: app.isReady() ? app.getAppMetrics().map(metric => ({ pid: metric.pid, type: metric.type, memory: metric.memory })) : [],
    };
  } catch (error) {
    context = { contextError: String(error).slice(0, 300) };
  }
  const write = (value: Record<string, unknown>): void => {
    void rendererDiagnostics.record(value).catch(error => console.error("Renderer diagnostics could not be saved:", error.message));
  };
  write({ ...event, ...context });
  if (event.kind === "manual-recovery-requested" || event.kind === "manual-recovery-completed") return;
  if (!pendingCommitSample) {
    const sample = windowsCommitMemory();
    pendingCommitSample = sample;
    void sample.finally(() => { if (pendingCommitSample === sample) pendingCommitSample = null; }).catch(() => undefined);
  }
  void pendingCommitSample.then(
    memory => write({ kind: "system-memory-sample", role: event.role, relatedEvent: event.kind, memory }),
    error => write({ kind: "system-memory-unavailable", role: event.role, message: String(error.message).slice(0, 300) }),
  );
}

function canSendToWindow(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed());
}

async function confirmFloatingRendererReady(role: FloatingWindowRole, window: BrowserWindow): Promise<void> {
  const version = floatingRendererHealth.version(role);
  const deadline = Date.now() + 10_000;
  const expression = role === "avatar"
    ? 'Boolean(document.readyState !== "loading" && document.getElementById("floatingAvatar")?.complete && document.getElementById("floatingAvatar")?.naturalWidth > 0)'
    : 'Boolean(document.readyState !== "loading" && document.getElementById("floatingSubtitle"))';
  while (Date.now() < deadline) {
    if (getFloatingWindow(role) !== window || !canSendToWindow(window) || floatingRendererHealth.version(role) !== version) return;
    const ready = await Promise.race([
      window.webContents.executeJavaScript(expression).catch(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)),
    ]);
    if (getFloatingWindow(role) !== window || !canSendToWindow(window) || floatingRendererHealth.version(role) !== version) return;
    if (ready) {
      floatingRendererHealth.ready(role, window.webContents.getOSProcessId(), version);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (getFloatingWindow(role) === window && floatingRendererHealth.version(role) === version) {
    floatingRendererHealth.failed(role, "ready-timeout", "立ち絵または字幕を読み込めませんでした。");
  }
}

function watchFloatingRenderer(role: FloatingWindowRole, window: BrowserWindow): void {
  floatingRendererHealth.loading(role);
  const isCurrent = (): boolean => getFloatingWindow(role) === window;
  window.webContents.on("did-start-loading", () => { if (isCurrent()) floatingRendererHealth.loading(role); });
  window.webContents.on("render-process-gone", (_event, details) => {
    if (isCurrent()) floatingRendererHealth.stopped(role, details.reason, details.exitCode);
  });
  window.webContents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
    if (isCurrent() && mainFrame && code !== -3) floatingRendererHealth.failed(role, `load-${code}`, description);
  });
  window.on("unresponsive", () => { if (isCurrent()) floatingRendererHealth.unresponsive(role); });
  window.on("responsive", () => { if (isCurrent()) void confirmFloatingRendererReady(role, window); });
  window.on("show", () => { if (isCurrent()) publishFloatingRendererHealth(); });
  window.on("hide", () => { if (isCurrent()) publishFloatingRendererHealth(); });
}

function focusExistingWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    return;
  }
  const floatingWindow = getFloatingWindow("avatar") ?? getFloatingWindow("subtitle");
  if (floatingWindow) {
    if (!floatingWindow.isVisible()) {
      floatingWindow.showInactive();
    }
    floatingWindow.focus();
  }
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 920,
    minHeight: 680,
    title: "RealPCtuber Codexia",
    backgroundColor: "#f4f6f8",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  installTextInputContextMenu(window);
  window.loadFile(join(publicDir, "index.html"));
  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });
  window.on("closed", () => {
    mainWindow = null;
  });
  return window;
}

function createFloatingWindow(role: FloatingWindowRole, previousBounds?: Electron.Rectangle): BrowserWindow {
  if (previousBounds) {
    completedInitialFloatingFit.add(role);
    lastFloatingBounds.set(role, previousBounds);
  } else {
    completedInitialFloatingFit.delete(role);
    lastFloatingBounds.delete(role);
  }
  const overlayBounds = previousBounds ?? getInitialFloatingBounds(role);
  const window = new BrowserWindow({
    ...overlayBounds,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    backgroundColor: "#00000000",
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  installTextInputContextMenu(window);
  window.setAlwaysOnTop(true, "screen-saver");
  setFloatingInputPassthrough(role, window, true);
  watchFloatingRenderer(role, window);
  window.on("closed", () => {
    if ((role === "avatar" ? floatingAvatarWindow : floatingSubtitleWindow) !== window) return;
    setFloatingWindow(role, null);
    floatingRendererHealth.closed(role);
    runtime.setFloatingOverlayStatus({ running: hasAnyFloatingWindow() });
  });
  window.webContents.on("did-finish-load", () => {
    if (getFloatingWindow(role) !== window || !canSendToWindow(window)) return;
    window.webContents.send("codexia:snapshot", runtime.getSnapshot());
    window.webContents.send("codexia:floating-role-visibility-changed", getFloatingRoleVisibility());
    void confirmFloatingRendererReady(role, window);
  });
  void window.loadFile(join(publicDir, "floating.html"), { query: { role } }).catch(() => undefined);
  return window;
}

function installTextInputContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable) {
      return;
    }
    Menu.buildFromTemplate([
      { label: "元に戻す", role: "undo", enabled: params.editFlags.canUndo },
      { label: "やり直す", role: "redo", enabled: params.editFlags.canRedo },
      { type: "separator" },
      { label: "切り取り", role: "cut", enabled: params.editFlags.canCut },
      { label: "コピー", role: "copy", enabled: params.editFlags.canCopy },
      { label: "貼り付け", role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { label: "すべて選択", role: "selectAll", enabled: params.editFlags.canSelectAll },
    ]).popup({ window });
  });
}

function getInitialFloatingBounds(role: FloatingWindowRole): Electron.Rectangle {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = role === "avatar"
    ? Math.min(620, Math.max(360, area.width))
    : Math.min(1280, Math.max(560, area.width));
  const height = role === "avatar"
    ? Math.min(820, Math.max(420, area.height))
    : Math.min(340, Math.max(180, area.height));
  return {
    x: role === "avatar" ? area.x + Math.max(0, area.width - width - 24) : area.x + 24,
    y: area.y + Math.max(0, area.height - height - 24),
    width,
    height,
  };
}

function requestFloatingWindowFit(): void {
  for (const window of getFloatingWindows()) {
    if (canSendToWindow(window)) window.webContents.send("codexia:fit-floating-window");
  }
}

function setFloatingWindowContentBounds(window: BrowserWindow, value: unknown): void {
  const role = getFloatingWindowRole(window);
  if (!role || !isRecord(value)) {
    return;
  }
  const normalizedBounds = normalizeFloatingBounds(value);
  if (!normalizedBounds) {
    return;
  }
  const bounds = role === "avatar" && !completedInitialFloatingFit.has(role)
    ? anchorAvatarBoundsToPrimaryDisplay(normalizedBounds)
    : constrainFloatingBoundsToDisplay(role, normalizedBounds);
  completedInitialFloatingFit.add(role);
  const lastBounds = lastFloatingBounds.get(role);
  if (
    lastBounds &&
    lastBounds.x === bounds.x &&
    lastBounds.y === bounds.y &&
    lastBounds.width === bounds.width &&
    lastBounds.height === bounds.height
  ) {
    return;
  }
  lastFloatingBounds.set(role, bounds);
  window.setBounds(bounds, false);
}

function anchorAvatarBoundsToPrimaryDisplay(bounds: Electron.Rectangle): Electron.Rectangle {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    x: area.x + Math.max(0, area.width - width - 24),
    y: area.y + Math.max(0, area.height - height - 24),
    width,
    height,
  };
}

function constrainFloatingBoundsToDisplay(role: FloatingWindowRole, bounds: Electron.Rectangle): Electron.Rectangle {
  const center = {
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  };
  const display = role === "subtitle"
    ? screen.getDisplayMatching(bounds)
    : screen.getDisplayNearestPoint(center);
  const area = display.workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - width));
  return {
    x,
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width,
    height,
  };
}

function normalizeFloatingBounds(value: Record<string, unknown>): Electron.Rectangle | null {
  const x = Math.round(Number(value.x));
  const y = Math.round(Number(value.y));
  const width = Math.round(Number(value.width));
  const height = Math.round(Number(value.height));
  if (![x, y, width, height].every(Number.isFinite)) {
    return null;
  }
  return {
    x,
    y,
    width: Math.max(120, Math.min(width, 5000)),
    height: Math.max(120, Math.min(height, 3000)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function loadFloatingRoleVisibility(): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await readFile(floatingOverlaySettingsPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.roles)) {
      return;
    }
    for (const role of floatingWindowRoles) {
      if (typeof parsed.roles[role] === "boolean") {
        floatingRoleVisibility[role] = parsed.roles[role];
      }
    }
  } catch {
    // Missing or malformed settings fall back to both floating roles being visible.
  }
}

async function saveFloatingRoleVisibility(): Promise<void> {
  await mkdir(dirname(floatingOverlaySettingsPath), { recursive: true });
  await writeFile(
    floatingOverlaySettingsPath,
    `${JSON.stringify(getFloatingRoleVisibility(), null, 2)}\n`,
    "utf8",
  );
}

function getFloatingRoleVisibility(): { roles: Record<FloatingWindowRole, boolean> } {
  return { roles: { ...floatingRoleVisibility } };
}

function broadcastFloatingRoleVisibility(): void {
  const visibility = getFloatingRoleVisibility();
  for (const window of [mainWindow, ...getFloatingWindows()]) {
    if (canSendToWindow(window)) {
      window.webContents.send("codexia:floating-role-visibility-changed", visibility);
    }
  }
}

async function setFloatingRoleVisible(role: FloatingWindowRole, visible: boolean): Promise<{
  roles: Record<FloatingWindowRole, boolean>;
}> {
  floatingRoleVisibility[role] = visible;
  floatingRendererHealth.setEnabled(role, visible);
  const overlay = runtime.getSnapshot().overlay as { desiredVisible?: boolean };
  let window = getFloatingWindow(role);
  if (visible && overlay.desiredVisible && !window) {
    window = createFloatingWindow(role);
    setFloatingWindow(role, window);
  }
  if (window) {
    if (visible && overlay.desiredVisible) {
      window.showInactive();
      setFloatingInputPassthrough(role, window, true);
      if (canSendToWindow(window)) window.webContents.send("codexia:snapshot", runtime.getSnapshot());
    } else {
      window.hide();
    }
  }
  await saveFloatingRoleVisibility();
  broadcastFloatingRoleVisibility();
  requestFloatingWindowFit();
  return getFloatingRoleVisibility();
}

function setFloatingInputPassthrough(role: FloatingWindowRole, window: BrowserWindow, passthrough: boolean): void {
  floatingInputPassthrough.set(role, passthrough);
  if (passthrough) {
    window.setIgnoreMouseEvents(true, { forward: true });
  } else {
    window.setIgnoreMouseEvents(false);
  }
  if (canSendToWindow(window)) window.webContents.send("codexia:floating-input-passthrough-changed", passthrough);
}

function sendSnapshot(snapshot: ElectronRuntimeSnapshot): void {
  for (const window of [mainWindow, ...getFloatingWindows()]) {
    if (canSendToWindow(window)) {
      window.webContents.send("codexia:snapshot", snapshot);
    }
  }
}

function getFloatingWindow(role: FloatingWindowRole): BrowserWindow | null {
  const window = role === "avatar" ? floatingAvatarWindow : floatingSubtitleWindow;
  return window && !window.isDestroyed() ? window : null;
}

function setFloatingWindow(role: FloatingWindowRole, window: BrowserWindow | null): void {
  if (role === "avatar") {
    floatingAvatarWindow = window;
  } else {
    floatingSubtitleWindow = window;
  }
}

function getFloatingWindows(): BrowserWindow[] {
  return floatingWindowRoles
    .map((role) => getFloatingWindow(role))
    .filter((window): window is BrowserWindow => Boolean(window));
}

function hasAnyFloatingWindow(): boolean {
  return getFloatingWindows().length > 0;
}

function getFloatingWindowRole(window: BrowserWindow): FloatingWindowRole | null {
  if (window === getFloatingWindow("avatar")) {
    return "avatar";
  }
  if (window === getFloatingWindow("subtitle")) {
    return "subtitle";
  }
  return null;
}

function ensureFloatingWindows(): BrowserWindow[] {
  for (const role of floatingWindowRoles) {
    if (!getFloatingWindow(role)) {
      setFloatingWindow(role, createFloatingWindow(role));
    }
  }
  return getFloatingWindows();
}

async function showFloatingWindow(): Promise<Record<string, unknown>> {
  const windows = ensureFloatingWindows();
  runtime.setFloatingOverlayStatus({ desiredVisible: true, running: true, lastError: null });
  for (const window of windows) {
    const role = getFloatingWindowRole(window);
    if (!role || !floatingRoleVisibility[role]) {
      window.hide();
      continue;
    }
    if (!window.isVisible()) {
      window.showInactive();
    }
    setFloatingInputPassthrough(role, window, true);
    if (canSendToWindow(window)) window.webContents.send("codexia:snapshot", runtime.getSnapshot());
  }
  requestFloatingWindowFit();
  return runtime.getSnapshot().overlay;
}

function hideFloatingWindow(): Record<string, unknown> {
  for (const window of getFloatingWindows()) {
    window.hide();
  }
  runtime.setFloatingOverlayStatus({ desiredVisible: false, running: hasAnyFloatingWindow() });
  return runtime.getSnapshot().overlay;
}

async function recoverFloatingAvatar(): Promise<Record<string, unknown>> {
  await manualFloatingRecovery.run(async () => {
    const previous = getFloatingWindow("avatar");
    const bounds = previous?.getBounds();
    const passthrough = floatingInputPassthrough.get("avatar") ?? true;
    const desiredVisible = Boolean(runtime.getSnapshot().overlay.desiredVisible);
    floatingRendererHealth.recovering("avatar");
    try {
      const replacement = createFloatingWindow("avatar", bounds);
      setFloatingWindow("avatar", replacement);
      if (previous && !previous.isDestroyed()) previous.destroy();
      if (desiredVisible && floatingRoleVisibility.avatar) replacement.showInactive();
      setFloatingInputPassthrough("avatar", replacement, passthrough);
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const status = floatingRendererHealth.snapshot().avatar.status;
        if (status === "ready") {
          runtime.setFloatingOverlayStatus({ running: hasAnyFloatingWindow(), lastError: null });
          return;
        }
        if (["error", "stopped", "closed"].includes(status)) throw new Error("立ち絵を復旧できませんでした。原因ログを確認してください。");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("立ち絵の復旧が時間内に完了しませんでした。");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      floatingRendererHealth.failed("avatar", "manual-recovery-failed", message);
      throw error;
    }
  });
  return runtime.getSnapshot().overlay;
}

function wireIpc(): void {
  ipcMain.handle("codexia:get-state", () => runtime.getSnapshot());
  ipcMain.handle("codexia:post-event", (_event, payload) => runtime.postEvent(payload));
  ipcMain.handle("codexia:start-thread-watch", (_event, payload) => runtime.startThreadWatch(payload));
  ipcMain.handle("codexia:stop-thread-watch", (_event, payload) => {
    const threadId = typeof payload?.threadId === "string" ? payload.threadId : "";
    return runtime.stopThreadWatch(threadId);
  });
  ipcMain.handle("codexia:get-thread-profiles", () => runtime.getThreadProfiles());
  ipcMain.handle("codexia:get-speech-volume", () => runtime.getSpeechVolume());
  ipcMain.handle("codexia:set-speech-volume", (_event, payload) => runtime.setSpeechVolume(payload?.volume));
  ipcMain.handle("codexia:lookup-thread-name", async (_event, payload) => ({
    name: await readCodexThreadNameFromIndex(typeof payload?.threadId === "string" ? payload.threadId : ""),
  }));
  ipcMain.handle("codexia:save-thread-profile", (_event, payload) => runtime.saveThreadProfile(payload));
  ipcMain.handle("codexia:set-voicevox-acceleration", (_event, payload) =>
    runtime.setVoicevoxAcceleration(payload?.acceleration),
  );
  ipcMain.handle("codexia:get-floating-overlay", () => ({ overlay: runtime.getSnapshot().overlay }));
  ipcMain.handle("codexia:get-floating-role-visibility", () => getFloatingRoleVisibility());
  ipcMain.handle("codexia:set-floating-role-visibility", async (_event, payload) => {
    const role = typeof payload?.role === "string" ? payload.role : "";
    if (!floatingWindowRoles.includes(role as FloatingWindowRole)) {
      throw new Error("role must be avatar or subtitle.");
    }
    if (typeof payload?.visible !== "boolean") {
      throw new Error("visible must be a boolean.");
    }
    return setFloatingRoleVisible(role as FloatingWindowRole, payload.visible);
  });
  ipcMain.handle("codexia:floating-overlay-action", async (_event, payload) => {
    const action = typeof payload?.action === "string" ? payload.action : "";
    if (action === "recover") return { overlay: await recoverFloatingAvatar() };
    if (action === "hide") {
      return { overlay: hideFloatingWindow() };
    }
    if (action === "show" || action === "start") {
      return { overlay: await showFloatingWindow() };
    }
    if (action === "toggle") {
      const overlay = runtime.getSnapshot().overlay as { desiredVisible?: boolean; running?: boolean };
      if (overlay.desiredVisible && overlay.running) {
        return { overlay: hideFloatingWindow() };
      }
      return { overlay: await showFloatingWindow() };
    }
    throw new Error("action must be show, hide, toggle, start, or recover.");
  });
  ipcMain.on("codexia:set-floating-input-passthrough", (event, passthrough) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return;
    }
    const role = getFloatingWindowRole(window);
    if (!role) {
      return;
    }
    const next = Boolean(passthrough);
    if (next === (floatingInputPassthrough.get(role) ?? true)) {
      event.sender.send("codexia:floating-input-passthrough-changed", next);
      return;
    }
    setFloatingInputPassthrough(role, window, next);
  });
  ipcMain.on("codexia:set-floating-window-bounds", (event, payload) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) {
      setFloatingWindowContentBounds(window, payload);
    }
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusExistingWindow();
  });
  app.on("browser-window-blur", (_event, window) => {
    const role = getFloatingWindowRole(window);
    if (role) {
      setFloatingInputPassthrough(role, window, true);
    }
  });
  app.on("child-process-gone", (_event, details) => {
    if (details.type === "GPU") logRendererDiagnostic({ kind: "gpu-process-gone", role: "gpu", reason: details.reason, exitCode: details.exitCode });
  });
  app.on("render-process-gone", (_event, contents, details) => {
    if (mainWindow?.webContents === contents) logRendererDiagnostic({ kind: "renderer-process-gone", role: "main", reason: details.reason, exitCode: details.exitCode });
  });

  app.whenReady().then(async () => {
    wireIpc();
    runtime.on("snapshot", (snapshot) => sendSnapshot(snapshot as ElectronRuntimeSnapshot));
    await runtime.initialize();
    await loadFloatingRoleVisibility();
    for (const role of floatingWindowRoles) floatingRendererHealth.setEnabled(role, floatingRoleVisibility[role]);
    voiceExportServer = await startVoiceExportServer(runtime);
    mainWindow = createMainWindow();
    await showFloatingWindow();
    screen.on("display-added", requestFloatingWindowFit);
    screen.on("display-removed", requestFloatingWindowFit);
    screen.on("display-metrics-changed", requestFloatingWindowFit);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      } else {
        focusExistingWindow();
      }
    });
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });

  app.on("before-quit", () => {
    voiceExportServer?.close();
    voiceExportServer = null;
    runtime.dispose();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
