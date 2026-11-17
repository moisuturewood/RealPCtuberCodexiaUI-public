const state = {
  snapshot: null,
  frames: null,
  threadProfiles: [],
  threadProfilesLoaded: false,
  mouthOpen: false,
  mouthFrame: "closed",
  blinkUntil: 0,
  autoStartAttempted: false,
  activeWatcherThreadId: "",
  floatingRecoveryPending: false,
};

const codexiaBridge = window.codexia || null;

const elements = {
  connectionDot: document.getElementById("connectionDot"),
  connectionText: document.getElementById("connectionText"),
  voiceState: document.getElementById("voiceState"),
  avatar: document.getElementById("avatar"),
  subtitle: document.getElementById("subtitle"),
  currentText: document.getElementById("currentText"),
  emotion: document.getElementById("emotion"),
  gesture: document.getElementById("gesture"),
  mouthLayer: document.getElementById("mouthLayer"),
  queue: document.getElementById("queue"),
  history: document.getElementById("history"),
  lastError: document.getElementById("lastError"),
  postForm: document.getElementById("postForm"),
  postText: document.getElementById("postText"),
  postKind: document.getElementById("postKind"),
  watchForm: document.getElementById("watchForm"),
  threadProfileSelect: document.getElementById("threadProfileSelect"),
  threadNameInput: document.getElementById("threadNameInput"),
  autoStartWatch: document.getElementById("autoStartWatch"),
  threadIdInput: document.getElementById("threadIdInput"),
  replayRecent: document.getElementById("replayRecent"),
  includeTools: document.getElementById("includeTools"),
  stopWatch: document.getElementById("stopWatch"),
  watchStatus: document.getElementById("watchStatus"),
  floatingToggle: document.getElementById("floatingToggle"),
  floatingRecover: document.getElementById("floatingRecover"),
  floatingSubtitleVisible: document.getElementById("floatingSubtitleVisible"),
  floatingStatus: document.getElementById("floatingStatus"),
  voicevoxAccelerationInputs: Array.from(document.querySelectorAll('input[name="voicevoxAcceleration"]')),
  voicevoxAccelerationStatus: document.getElementById("voicevoxAccelerationStatus"),
};

restoreWatchSettings();
void loadThreadProfiles();
connectRuntime();
wireWatchForm();
wireFloatingControls();
void loadFloatingRoleVisibility();
wireVoicevoxSettings();
wirePostForm();
renderWatcherStatus([]);
setInterval(tickAvatar, 45);
setInterval(scheduleBlink, 1800);
if (!codexiaBridge) {
  setInterval(loadFloatingOverlayState, 2500);
}

function connectRuntime() {
  if (codexiaBridge) {
    setConnection(true, "アプリ接続");
    codexiaBridge.onFloatingRoleVisibilityChanged?.(renderFloatingRoleVisibility);
    codexiaBridge.onSnapshot((snapshot) => {
      state.snapshot = snapshot;
      state.frames = snapshot.avatarFrames;
      render();
    });
    void codexiaBridge.getState().then((snapshot) => {
      state.snapshot = snapshot;
      state.frames = snapshot.avatarFrames;
      render();
    }).catch((error) => showError(error.message));
    return;
  }
  connectWebSocket();
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener("open", () => setConnection(true, "接続"));
  socket.addEventListener("close", () => {
    setConnection(false, "再接続中");
    setTimeout(connectWebSocket, 1200);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "snapshot") {
      state.snapshot = message.payload;
      state.frames = message.payload.avatarFrames;
      render();
    }
  });
}

function setConnection(connected, label = null) {
  elements.connectionDot.classList.toggle("connected", connected);
  elements.connectionText.textContent = label || (connected ? "接続" : "再接続中");
}

function restoreWatchSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("codexiaWatchSettings") || "{}");
    if (typeof saved.threadId === "string" && saved.threadId.trim()) {
      elements.threadIdInput.value = saved.threadId;
    }
    if (typeof saved.threadName === "string" && saved.threadName.trim()) {
      elements.threadNameInput.value = saved.threadName;
    }
    if (typeof saved.autoStart === "boolean") {
      elements.autoStartWatch.checked = saved.autoStart;
    }
    elements.replayRecent.checked = false;
  } catch {
    // Keep built-in defaults when localStorage is unavailable or malformed.
  }
  elements.replayRecent.checked = false;
}

function saveWatchSettings() {
  try {
    localStorage.setItem(
      "codexiaWatchSettings",
      JSON.stringify({
        threadId: elements.threadIdInput.value,
        threadName: elements.threadNameInput.value,
        autoStart: elements.autoStartWatch.checked,
      }),
    );
  } catch {
    // Non-fatal; the current form values still work.
  }
}

function wireWatchForm() {
  elements.autoStartWatch.addEventListener("change", () => {
    saveWatchSettings();
    if (!state.snapshot?.threadWatchers?.length) {
      renderWatcherStatus([]);
    }
  });
  elements.threadProfileSelect.addEventListener("change", async () => {
    const profile = state.threadProfiles.find((item) => item.threadId === elements.threadProfileSelect.value);
    if (!profile) {
      return;
    }
    elements.threadIdInput.value = profile.threadId;
    elements.threadNameInput.value = profile.name;
    saveWatchSettings();
    if (!elements.autoStartWatch.checked) {
      return;
    }
    const button = elements.watchForm.querySelector("button[type='submit']");
    button.disabled = true;
    try {
      state.autoStartAttempted = true;
      await startThreadWatch();
    } catch (error) {
      showError(error.message);
    } finally {
      button.disabled = false;
    }
  });
  elements.threadNameInput.addEventListener("change", saveWatchSettings);
  elements.threadIdInput.addEventListener("change", saveWatchSettings);
  elements.threadIdInput.addEventListener("input", syncSelectedThreadProfile);
  elements.replayRecent.checked = false;
  elements.includeTools.addEventListener("change", () => {
    if (!state.snapshot?.threadWatchers?.length) {
      renderWatcherStatus([]);
    }
  });

  elements.watchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = elements.watchForm.querySelector("button[type='submit']");
    button.disabled = true;
    try {
      state.autoStartAttempted = true;
      await startThreadWatch();
    } catch (error) {
      showError(error.message);
    } finally {
      button.disabled = false;
    }
  });

  elements.stopWatch.addEventListener("click", async () => {
    elements.stopWatch.disabled = true;
    try {
      state.autoStartAttempted = true;
      const activeWatcher = state.snapshot?.threadWatchers?.[0];
      await postJson("/api/thread-watch/stop", {
        threadId: activeWatcher?.threadId || elements.threadIdInput.value,
      });
    } catch (error) {
      showError(error.message);
    } finally {
      elements.stopWatch.disabled = false;
    }
  });
}

function wireFloatingControls() {
  elements.floatingToggle.addEventListener("click", async () => {
    const overlay = state.snapshot?.overlay || {};
    const shouldHide = Boolean(overlay.running && overlay.desiredVisible);
    elements.floatingToggle.disabled = true;
    try {
      const payload = await postJson("/api/floating-overlay", {
        action: shouldHide ? "hide" : "show",
      });
      state.snapshot = {
        ...(state.snapshot || {}),
        overlay: payload.overlay,
      };
      renderFloatingOverlayStatus(payload.overlay);
    } catch (error) {
      showError(error.message);
    } finally {
      elements.floatingToggle.disabled = false;
    }
  });
  elements.floatingRecover.addEventListener("click", async () => {
    if (!codexiaBridge || state.floatingRecoveryPending) return;
    state.floatingRecoveryPending = true;
    renderFloatingOverlayStatus(state.snapshot?.overlay);
    try {
      const payload = await codexiaBridge.floatingOverlayAction({ action: "recover" });
      if (state.snapshot) state.snapshot.overlay = payload.overlay;
    } catch (error) {
      showError(error.message);
    } finally {
      state.floatingRecoveryPending = false;
      renderFloatingOverlayStatus(state.snapshot?.overlay);
    }
  });
  elements.floatingSubtitleVisible.addEventListener("change", async () => {
    if (!codexiaBridge?.setFloatingRoleVisibility) {
      return;
    }
    elements.floatingSubtitleVisible.disabled = true;
    try {
      const visibility = await codexiaBridge.setFloatingRoleVisibility({
        role: "subtitle",
        visible: elements.floatingSubtitleVisible.checked,
      });
      renderFloatingRoleVisibility(visibility);
    } catch (error) {
      showError(error.message);
      await loadFloatingRoleVisibility();
    } finally {
      elements.floatingSubtitleVisible.disabled = false;
    }
  });
}

async function loadFloatingRoleVisibility() {
  if (!codexiaBridge?.getFloatingRoleVisibility) {
    elements.floatingSubtitleVisible.disabled = true;
    return;
  }
  try {
    renderFloatingRoleVisibility(await codexiaBridge.getFloatingRoleVisibility());
  } catch (error) {
    showError(error.message);
  }
}

function renderFloatingRoleVisibility(visibility) {
  if (typeof visibility?.roles?.subtitle === "boolean") {
    elements.floatingSubtitleVisible.checked = visibility.roles.subtitle;
  }
}

function wireVoicevoxSettings() {
  for (const input of elements.voicevoxAccelerationInputs) {
    input.addEventListener("change", async () => {
      if (!input.checked) {
        return;
      }
      setVoicevoxControlsDisabled(true);
      elements.voicevoxAccelerationStatus.textContent = "切替中";
      try {
        await postJson("/api/voicevox-settings", { acceleration: input.value });
      } catch (error) {
        showError(error.message);
        renderVoicevoxSettings(state.snapshot);
      } finally {
        setVoicevoxControlsDisabled(false);
      }
    });
  }
}

async function loadFloatingOverlayState() {
  try {
    const payload = await getJson("/api/floating-overlay");
    state.snapshot = {
      ...(state.snapshot || {}),
      overlay: payload.overlay,
    };
    renderFloatingOverlayStatus(payload.overlay);
  } catch {
    // WebSocket reconnects and the status panel surface server-wide errors.
  }
}

async function startThreadWatch() {
  saveWatchSettings();
  const payload = {
    threadId: elements.threadIdInput.value,
    replay: "none",
    includeTools: false,
    includeLifecycle: false,
    maxReplayEvents: 0,
  };
  const threadName = elements.threadNameInput.value.trim();
  if (threadName) {
    payload.threadName = threadName;
  }
  const result = await postJson("/api/thread-watch", payload);
  const resolvedThreadId = result?.profile?.threadId || normalizeThreadIdForUi(elements.threadIdInput.value);
  if (resolvedThreadId) {
    elements.threadIdInput.value = resolvedThreadId;
  }
  await loadThreadProfiles(resolvedThreadId);
}

async function loadThreadProfiles(preferredThreadId = elements.threadIdInput.value) {
  try {
    const payload = await getJson("/api/thread-profiles");
    state.threadProfiles = Array.isArray(payload.profiles) ? payload.profiles : [];
    renderThreadProfileSelect(preferredThreadId);
  } catch (error) {
    showError(error.message);
  } finally {
    state.threadProfilesLoaded = true;
    if (state.snapshot) {
      maybeAutoStartWatcher(state.snapshot.threadWatchers || []);
    }
  }
}

function renderThreadProfileSelect(selectedThreadId = "") {
  const current = normalizeThreadIdForUi(selectedThreadId || elements.threadIdInput.value);
  const options = [new Option("手入力", "")];
  for (const profile of state.threadProfiles) {
    options.push(new Option(threadProfileLabel(profile), profile.threadId));
  }
  elements.threadProfileSelect.replaceChildren(...options);
  const selectedProfile = state.threadProfiles.find((profile) => profile.threadId === current);
  elements.threadProfileSelect.value = selectedProfile ? selectedProfile.threadId : "";
  if (selectedProfile && elements.threadNameInput.value !== selectedProfile.name) {
    elements.threadNameInput.value = selectedProfile.name;
    saveWatchSettings();
  }
}

function syncSelectedThreadProfile() {
  const threadId = normalizeThreadIdForUi(elements.threadIdInput.value);
  const profile = state.threadProfiles.find((item) => item.threadId === threadId);
  elements.threadProfileSelect.value = profile ? profile.threadId : "";
  if (profile) {
    elements.threadNameInput.value = profile.name;
  } else {
    elements.threadNameInput.value = "";
  }
  saveWatchSettings();
  if (!profile && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(threadId)) {
    void postJson("/api/thread-name", { threadId }).then((result) => {
      if (normalizeThreadIdForUi(elements.threadIdInput.value) === threadId && !elements.threadNameInput.value.trim() && result?.name) {
        elements.threadNameInput.value = result.name;
        saveWatchSettings();
      }
    }).catch(() => {});
  }
}

function normalizeThreadIdForUi(value) {
  return String(value || "").trim().replace(/^codex:\/\/threads\//i, "");
}

function threadProfileLabel(profile) {
  const shortId = profile.threadId.length > 12 ? `${profile.threadId.slice(0, 8)}...${profile.threadId.slice(-4)}` : profile.threadId;
  return `${profile.name || "未命名"} / ${shortId}`;
}

function wirePostForm() {
  elements.postForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = elements.postForm.querySelector("button");
    button.disabled = true;
    try {
      await postJson("/api/events", {
        source: "manual",
        kind: elements.postKind.value,
        text: elements.postText.value,
        priority: "normal",
      });
    } catch (error) {
      showError(error.message);
    } finally {
      button.disabled = false;
    }
  });
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }
  const speaking = isSpeechActive();
  elements.voiceState.textContent = speaking ? "読み上げ中" : "待機";
  elements.avatar.classList.toggle("speaking", speaking);

  const current = snapshot.currentSpeech;
  const latest = snapshot.events?.[0];
  const text = current?.text || latest?.text || "待機しています。";
  renderSubtitleText(text);
  elements.currentText.textContent = current?.text || latest?.text || "読み上げ待機中";
  elements.emotion.textContent = snapshot.avatar?.emotion || "focused";
  elements.gesture.textContent = snapshot.avatar?.gesture || "idle";
  elements.mouthLayer.textContent = snapshot.avatar?.layers?.mouth || "-";

  elements.queue.replaceChildren(...(snapshot.speechQueue || []).slice().reverse().map(renderQueueItem));
  elements.history.replaceChildren(...(snapshot.events || []).slice(0, 30).map(renderHistoryItem));

  elements.lastError.textContent = snapshot.lastError || "正常";
  elements.lastError.classList.toggle("has-error", Boolean(snapshot.lastError));
  syncWatchFormToActiveWatcher(snapshot.threadWatchers || []);
  renderWatcherStatus(snapshot.threadWatchers || []);
  renderFloatingOverlayStatus(snapshot.overlay || null);
  renderVoicevoxSettings(snapshot);
  maybeAutoStartWatcher(snapshot.threadWatchers || []);
  updateAvatarImage();
}

function syncWatchFormToActiveWatcher(watchers) {
  const activeWatcher = watchers[0];
  const activeThreadId = normalizeThreadIdForUi(activeWatcher?.threadId);
  if (!activeThreadId) {
    state.activeWatcherThreadId = "";
    return;
  }
  if (state.activeWatcherThreadId === activeThreadId) {
    return;
  }

  state.activeWatcherThreadId = activeThreadId;
  elements.threadIdInput.value = activeThreadId;
  const profile = state.threadProfiles.find((item) => item.threadId === activeThreadId);
  elements.threadProfileSelect.value = profile ? profile.threadId : "";
  if (profile) {
    elements.threadNameInput.value = profile.name;
  }
  saveWatchSettings();
}

function maybeAutoStartWatcher(watchers) {
  if (state.autoStartAttempted || watchers.length > 0 || !elements.autoStartWatch.checked || !state.threadProfilesLoaded) {
    return;
  }
  if (!elements.threadIdInput.value.trim()) {
    return;
  }
  state.autoStartAttempted = true;
  void startThreadWatch().catch((error) => {
    showError(error.message);
  });
}

async function postJson(url, body) {
  if (codexiaBridge) {
    return invokeBridge(url, body);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function getJson(url) {
  if (codexiaBridge) {
    return invokeBridge(url);
  }
  const response = await fetch(url);
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function invokeBridge(url, body = undefined) {
  if (url === "/api/floating-overlay") {
    return body ? codexiaBridge.floatingOverlayAction(body) : codexiaBridge.getFloatingOverlay();
  }
  if (url === "/api/thread-profiles") {
    return body ? codexiaBridge.saveThreadProfile(body) : codexiaBridge.getThreadProfiles();
  }
  if (url === "/api/thread-name") {
    return codexiaBridge.lookupThreadName(body);
  }
  if (url === "/api/thread-watch") {
    return codexiaBridge.startThreadWatch(body);
  }
  if (url === "/api/thread-watch/stop") {
    return codexiaBridge.stopThreadWatch(body);
  }
  if (url === "/api/events") {
    return codexiaBridge.postEvent(body);
  }
  if (url === "/api/state") {
    return codexiaBridge.getState();
  }
  if (url === "/api/voicevox-settings") {
    return codexiaBridge.setVoicevoxAcceleration(body);
  }
  throw new Error(`Unsupported app bridge route: ${url}`);
}

function renderVoicevoxSettings(snapshot) {
  const acceleration = snapshot?.server?.voicevoxAcceleration || "auto";
  for (const input of elements.voicevoxAccelerationInputs) {
    input.checked = input.value === acceleration;
    input.disabled = Boolean(snapshot?.avatar?.speaking);
  }
  const labels = { auto: "自動選択", cpu: "CPU推論", gpu: "GPU推論" };
  elements.voicevoxAccelerationStatus.textContent = labels[acceleration] || acceleration;
}

function setVoicevoxControlsDisabled(disabled) {
  for (const input of elements.voicevoxAccelerationInputs) {
    input.disabled = disabled;
  }
}

function showError(message) {
  elements.lastError.textContent = message;
  elements.lastError.classList.add("has-error");
}

function renderSubtitleText(text) {
  if (elements.subtitle.dataset.text === text) {
    return;
  }
  elements.subtitle.dataset.text = text;
  elements.subtitle.setAttribute("aria-label", text);
  const outer = document.createElement("span");
  outer.className = "subtitle-layer subtitle-layer-outer";
  outer.setAttribute("aria-hidden", "true");
  outer.textContent = text;
  const white = document.createElement("span");
  white.className = "subtitle-layer subtitle-layer-white";
  white.setAttribute("aria-hidden", "true");
  white.textContent = text;
  const fill = document.createElement("span");
  fill.className = "subtitle-layer subtitle-layer-fill";
  fill.setAttribute("aria-hidden", "true");
  fill.textContent = text;
  elements.subtitle.replaceChildren(outer, white, fill);
}

function renderWatcherStatus(watchers) {
  if (watchers.length === 0) {
    elements.watchStatus.textContent = `未接続 / ${watchModeText()}`;
    elements.watchStatus.classList.remove("has-error");
    return;
  }
  const lines = watchers.map((watcher) => {
    const count = `${watcher.emittedCount || 0}件`;
    const file = watcher.filePath ? watcher.filePath.split(/[\\/]/).pop() : "検索中";
    const threadId = normalizeThreadIdForUi(watcher.threadId);
    const profile = state.threadProfiles.find((item) => item.threadId === threadId);
    const target = profile ? threadProfileLabel(profile) : threadId || "未選択";
    return `${watcher.status} / ${count} / ${target} / ${watchModeText(watcher)} / ${file}`;
  });
  elements.watchStatus.textContent = lines.join("\n");
  elements.watchStatus.classList.toggle("has-error", watchers.some((watcher) => watcher.status === "error"));
}

function renderFloatingOverlayStatus(overlay) {
  const running = Boolean(overlay?.running);
  const visible = Boolean(overlay?.desiredVisible);
  const renderer = overlay?.renderers?.avatar;
  const recovering = state.floatingRecoveryPending || renderer?.status === "recovering";
  elements.floatingRecover.disabled = !codexiaBridge || !renderer || recovering;
  elements.floatingRecover.textContent = recovering ? "復旧中…" : "立ち絵を復旧";
  elements.floatingToggle.textContent = running && visible ? "めたんちゃんをしまう" : "めたんちゃんを出す";
  if (renderer) {
    const wanted = visible && renderer.enabled;
    let text = "非表示";
    let failed = false;
    if (recovering) text = "立ち絵を復旧しています…";
    else if (wanted && ["stopped", "error", "unresponsive", "closed"].includes(renderer.status)) {
      text = renderer.reason === "oom" ? "立ち絵の表示停止（メモリ不足）―「立ち絵を復旧」を押してください" : "立ち絵の表示停止 ―「立ち絵を復旧」を押してください";
      failed = true;
    } else if (wanted) text = renderer.status === "ready" && renderer.visible ? "立ち絵：表示中" : "立ち絵：読み込み中";
    const subtitle = overlay.renderers.subtitle;
    if (visible && subtitle?.enabled) {
      if (["stopped", "error", "unresponsive", "closed"].includes(subtitle.status)) {
        text += " ／ 字幕：表示停止";
        failed = true;
      } else text += subtitle.status === "ready" && subtitle.visible ? " ／ 字幕：表示中" : " ／ 字幕：読み込み中";
    }
    elements.floatingStatus.textContent = text;
    elements.floatingStatus.classList.toggle("has-error", failed);
    return;
  }
  if (overlay?.lastError) {
    elements.floatingStatus.textContent = `エラー: ${overlay.lastError}`;
    elements.floatingStatus.classList.add("has-error");
    return;
  }
  elements.floatingStatus.textContent = running ? (visible ? "表示中" : "非表示") : (visible ? "未起動" : "非表示");
  elements.floatingStatus.classList.remove("has-error");
}

function watchModeText(watcher = null) {
  const replay = watcher ? watcher.replay !== "none" : elements.replayRecent.checked;
  const tools = watcher ? watcher.includeTools : false;
  const auto = watcher ? "開始済み" : `自動${elements.autoStartWatch.checked ? "ON" : "OFF"}`;
  return `${auto} / 直近${replay ? "ON" : "OFF"} / ツール${tools ? "ON" : "OFF"}`;
}

function renderQueueItem(job) {
  const li = document.createElement("li");
  const top = document.createElement("div");
  top.className = "item-top";
  const badge = document.createElement("span");
  badge.className = `badge ${job.status}`;
  badge.textContent = job.status;
  const time = document.createElement("span");
  time.textContent = formatTime(job.updatedAt);
  top.append(badge, time);

  const body = document.createElement("div");
  body.className = "item-text";
  body.textContent = job.error || job.text;
  li.append(top, body);
  return li;
}

function renderHistoryItem(item) {
  const li = document.createElement("li");
  const top = document.createElement("div");
  top.className = "item-top";
  const badge = document.createElement("span");
  badge.className = `badge ${item.kind === "error" ? "error" : ""}`;
  badge.textContent = item.kind;
  const source = document.createElement("span");
  source.textContent = item.source;
  const time = document.createElement("span");
  time.textContent = formatTime(item.createdAt);
  top.append(badge, source, time);

  const body = document.createElement("div");
  body.className = "item-text";
  body.textContent = item.text;
  li.append(top, body);
  return li;
}

function tickAvatar() {
  if (!state.snapshot || !state.frames) {
    return;
  }
  if (isSpeechActive()) {
    const synced = resolveLipSyncMouthFrame();
    if (synced) {
      state.mouthFrame = synced;
    } else {
      state.mouthOpen = !state.mouthOpen;
      state.mouthFrame = state.mouthOpen ? "open" : "small";
    }
  } else {
    state.mouthOpen = false;
    state.mouthFrame = "closed";
  }
  updateAvatarImage();
}

function scheduleBlink() {
  if (Math.random() > 0.35) {
    state.blinkUntil = performance.now() + 180;
    updateAvatarImage();
  }
}

function updateAvatarImage() {
  if (!state.frames) {
    return;
  }
  const now = performance.now();
  const closedEyes = state.frames.mouthEyes?.closed || {};
  let src = state.frames.closed || state.frames.idle || closedEyes.normal;
  if (isSpeechActive()) {
    const eyeFrame = now < state.blinkUntil ? "blink" : "normal";
    const fullMouthFrame = state.frames[state.mouthFrame] || state.frames.closed;
    src = eyeFrame === "blink"
      ? state.frames.mouthEyes?.[state.mouthFrame]?.blink || state.frames.blink || fullMouthFrame
      : fullMouthFrame;
  } else if (now < state.blinkUntil) {
    src = closedEyes.blink || state.frames.blink || state.frames.closed;
  }
  if (elements.avatar.getAttribute("src") !== src) {
    elements.avatar.setAttribute("src", src);
  }
}

function resolveLipSyncMouthFrame() {
  const speech = state.snapshot?.currentSpeech;
  if (!speech?.startedAt || !Array.isArray(speech.lipSync) || speech.lipSync.length === 0) {
    return null;
  }
  const startedAt = Date.parse(speech.startedAt);
  if (Number.isNaN(startedAt)) {
    return null;
  }
  const lipSyncLeadMs = Number(state.snapshot?.server?.lipSyncLeadMs ?? 60);
  const elapsedMs = Math.max(0, Date.now() - startedAt + lipSyncLeadMs);
  let frame = speech.lipSync[0]?.mouth || "closed";
  for (const item of speech.lipSync) {
    if (typeof item.atMs !== "number" || typeof item.mouth !== "string") {
      continue;
    }
    if (item.atMs > elapsedMs) {
      break;
    }
    frame = item.mouth;
  }
  return frame;
}

function isSpeechActive() {
  if (!state.snapshot?.avatar?.speaking) {
    return false;
  }
  const expectedEndedAt = state.snapshot.currentSpeech?.expectedEndedAt;
  if (!expectedEndedAt) {
    return true;
  }
  const endMs = Date.parse(expectedEndedAt);
  if (Number.isNaN(endMs)) {
    return true;
  }
  return Date.now() <= endMs + 80;
}

function formatTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
