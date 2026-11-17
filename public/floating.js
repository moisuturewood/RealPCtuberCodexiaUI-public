const state = {
  snapshot: null,
  frames: null,
  mouthFrame: "closed",
  blinkUntil: 0,
};

const floatingRole = normalizeFloatingRole(new URLSearchParams(location.search).get("role"));
const showsAvatar = floatingRole !== "subtitle";
const showsSubtitle = floatingRole !== "avatar";
document.body.dataset.floatingRole = floatingRole;
document.title = floatingRole === "avatar"
  ? "Floating Metan Avatar"
  : floatingRole === "subtitle"
    ? "Floating Metan Subtitle"
    : "Floating Metan";

const avatar = document.getElementById("floatingAvatar");
const subtitle = document.getElementById("floatingSubtitle");
const subtitleMenu = document.getElementById("subtitleMenu");
const subtitleOpacity = document.getElementById("subtitleOpacity");
const subtitleOpacityValue = document.getElementById("subtitleOpacityValue");
const subtitleVisibleToggle = document.getElementById("subtitleVisibleToggle");
const subtitleMenuReset = document.getElementById("subtitleMenuReset");
const subtitleMenuClose = document.getElementById("subtitleMenuClose");
const threadMenu = document.getElementById("threadMenu");
const threadMenuForm = document.getElementById("threadMenuForm");
const threadMenuSelect = document.getElementById("threadMenuSelect");
const threadMenuId = document.getElementById("threadMenuId");
const threadMenuName = document.getElementById("threadMenuName");
const threadMenuStart = document.getElementById("threadMenuStart");
const threadMenuSave = document.getElementById("threadMenuSave");
const threadMenuClose = document.getElementById("threadMenuClose");
const threadMenuStatus = document.getElementById("threadMenuStatus");
const threadMenuSubtitleVisible = document.getElementById("threadMenuSubtitleVisible");
const speechVolume = document.getElementById("speechVolume");
const speechVolumeValue = document.getElementById("speechVolumeValue");
let speechVolumeTimer;
const layoutStoreKey = "codexia-floating-layout-v5";
const subtitleGripPx = 120;
const compactWindowMargin = 32;
const compactMoveSpan = 12000;
const minimumSubtitleOpacity = 0.15;
const defaultSubtitleMaxWidthPx = Math.max(260, window.innerWidth - 16);
const layout = loadLayout();
const subtitleGraphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("ja", { granularity: "grapheme" })
  : null;
const subtitleEmojiPattern = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u20E3]/u;
let dragKey = null;
let inputPassthrough = null;
let threadMenuProfiles = [];
let threadMenuOpen = false;
let subtitleMenuOpen = false;
let compactWindowReady = false;
let fitWindowFrame = 0;
let fittingWindow = false;
let lastFloatingBoundsKey = "";
let subtitleResizeObserver = null;
let subtitleVisible = true;

window.codexia?.onFloatingInputPassthroughChanged?.((passthrough) => {
  inputPassthrough = Boolean(passthrough);
});

window.codexia?.onFloatingRoleVisibilityChanged?.(syncFloatingRoleVisibility);
void refreshFloatingRoleVisibility();

window.codexia?.onSnapshot((snapshot) => {
  state.snapshot = snapshot;
  state.frames = snapshot.avatarFrames;
  render();
});

window.codexia?.getState().then((snapshot) => {
  state.snapshot = snapshot;
  state.frames = snapshot.avatarFrames;
  render();
});

if (showsAvatar) {
  setInterval(tickAvatar, 45);
  setInterval(scheduleBlink, 1800);
  avatar.addEventListener("load", () => scheduleFitFloatingWindow());
}
if (showsSubtitle && typeof ResizeObserver === "function") {
  subtitleResizeObserver = new ResizeObserver(() => scheduleFitFloatingWindow());
  subtitleResizeObserver.observe(subtitle);
}
window.codexia?.onFitFloatingWindow?.(() => scheduleFitFloatingWindow());
applyLayout();
wireLayoutControls();

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }
  const current = snapshot.currentSpeech;
  const latest = snapshot.events?.[0];
  const text = current?.text || latest?.text || "待機しています。";
  if (showsSubtitle) {
    renderSubtitleText(text);
  }
  if (showsAvatar) {
    updateAvatarImage();
  }
  scheduleFitFloatingWindow();
}

function tickAvatar() {
  if (!state.snapshot || !state.frames) {
    return;
  }
  if (isSpeechActive()) {
    state.mouthFrame = resolveLipSyncMouthFrame() || "open";
  } else {
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
  if (avatar.getAttribute("src") !== src) {
    avatar.setAttribute("src", src);
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

function wireLayoutControls() {
  window.addEventListener("mousemove", updateInputPassthrough);
  window.addEventListener("mouseleave", () => setInputPassthrough(true));
  window.addEventListener("blur", () => setInputPassthrough(true));
  setInputPassthrough(true);
  if (showsAvatar) {
    makeDraggable(avatar, "avatar");
    avatar.addEventListener("wheel", (event) => {
      event.preventDefault();
      pinElement("avatar");
      const rect = avatar.getBoundingClientRect();
      const nextWidth = clamp(rect.width + wheelDirection(event) * 28, 180, Math.max(220, window.innerWidth * 0.72));
      layout.avatar.width = Math.round(nextWidth);
      applyLayout();
      saveLayout();
    }, { passive: false });
    avatar.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      void openThreadMenu(event.clientX, event.clientY);
    });
    threadMenuClose?.addEventListener("click", closeThreadMenu);
    threadMenuSelect?.addEventListener("change", () => {
      const profile = threadMenuProfiles.find((item) => item.threadId === threadMenuSelect.value);
      if (!profile) {
        return;
      }
      threadMenuId.value = profile.threadId;
      threadMenuName.value = profile.name || "";
      setThreadMenuStatus("");
    });
    threadMenuId?.addEventListener("input", syncThreadMenuProfileFromId);
    speechVolume?.addEventListener("input", () => {
      const volume = Number(speechVolume.value);
      speechVolumeValue.textContent = `${volume}%`;
      clearTimeout(speechVolumeTimer);
      speechVolumeTimer = setTimeout(() => {
        void window.codexia.setSpeechVolume(volume).catch((error) => setThreadMenuStatus(error.message));
      }, 80);
    });
    threadMenuForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      void startThreadFromMenu();
    });
    threadMenuSave?.addEventListener("click", () => {
      void saveThreadProfileFromMenu();
    });
    threadMenuSubtitleVisible?.addEventListener("change", () => {
      void setSubtitleVisible(threadMenuSubtitleVisible.checked);
    });
  }
  if (showsSubtitle) {
    makeDraggable(subtitle, "subtitle");
    subtitle.addEventListener("wheel", (event) => {
      event.preventDefault();
      pinElement("subtitle");
      if (event.shiftKey) {
        const rect = subtitle.getBoundingClientRect();
        const currentWidth = layout.subtitle.width ?? Math.max(rect.width, defaultSubtitleMaxWidthPx);
        layout.subtitle.width = Math.round(clamp(currentWidth + wheelDirection(event) * 160, 260, maxSubtitleWidth()));
      } else if (event.ctrlKey) {
        const current = layout.subtitle.lineHeight ?? Number.parseFloat(getComputedStyle(subtitle).lineHeight) / Number.parseFloat(getComputedStyle(subtitle).fontSize);
        layout.subtitle.lineHeight = Math.round(clamp(current + wheelDirection(event) * 0.08, 1.45, 2.6) * 100) / 100;
      } else {
        const current = layout.subtitle.fontSize ?? Number.parseFloat(getComputedStyle(subtitle).fontSize);
        layout.subtitle.fontSize = Math.round(clamp(current + wheelDirection(event) * 2, 18, 72));
      }
      applyLayout();
      saveLayout();
    }, { passive: false });
    subtitle.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openSubtitleMenu(event.clientX, event.clientY);
    });
    subtitleOpacity?.addEventListener("input", () => {
      const percent = Number(subtitleOpacity.value);
      layout.subtitle.opacity = clamp(percent / 100, minimumSubtitleOpacity, 1);
      syncSubtitleOpacityControl();
      applyLayout();
      saveLayout();
    });
    subtitleVisibleToggle?.addEventListener("change", () => {
      void setSubtitleVisible(subtitleVisibleToggle.checked);
    });
    subtitleMenuReset?.addEventListener("click", () => {
      layout.subtitle = {
        width: Math.min(defaultSubtitleMaxWidthPx, maxSubtitleWidth()),
        opacity: 1,
      };
      syncSubtitleOpacityControl();
      applyLayout();
      saveLayout();
      constrainSubtitleMenu();
    });
    subtitleMenuClose?.addEventListener("click", closeSubtitleMenu);
  }
  window.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    if (threadMenuOpen && !event.target?.closest?.(".thread-menu, .floating-avatar")) {
      closeThreadMenu();
    }
    if (subtitleMenuOpen && !event.target?.closest?.(".subtitle-menu, .floating-subtitle")) {
      closeSubtitleMenu();
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && threadMenuOpen) {
      closeThreadMenu();
    }
    if (event.key === "Escape" && subtitleMenuOpen) {
      closeSubtitleMenu();
    }
  });
  window.addEventListener("resize", () => {
    constrainPinnedLayout();
    constrainThreadMenu();
    constrainSubtitleMenu();
    applyLayout();
    saveLayout();
  });
}

function openSubtitleMenu(clientX, clientY) {
  if (!subtitleMenu) {
    return;
  }
  subtitleMenuOpen = true;
  subtitleMenu.hidden = false;
  syncSubtitleOpacityControl();
  syncSubtitleVisibilityControls();
  setInputPassthrough(false);
  positionSubtitleMenu(clientX, clientY);
  scheduleFitFloatingWindow();
}

function closeSubtitleMenu() {
  if (!subtitleMenu) {
    return;
  }
  subtitleMenuOpen = false;
  subtitleMenu.hidden = true;
  updateInputPassthrough();
  scheduleFitFloatingWindow();
}

function positionSubtitleMenu(clientX, clientY) {
  if (!subtitleMenu) {
    return;
  }
  subtitleMenu.style.left = `${clientX}px`;
  subtitleMenu.style.top = `${clientY}px`;
  constrainSubtitleMenu();
  scheduleFitFloatingWindow();
}

function constrainSubtitleMenu() {
  if (!subtitleMenu || subtitleMenu.hidden) {
    return;
  }
  const rect = subtitleMenu.getBoundingClientRect();
  const margin = 10;
  const left = clamp(rect.left, margin, Math.max(margin, window.innerWidth - rect.width - margin));
  const top = clamp(rect.top, margin, Math.max(margin, window.innerHeight - rect.height - margin));
  subtitleMenu.style.left = `${Math.round(left)}px`;
  subtitleMenu.style.top = `${Math.round(top)}px`;
}

function syncSubtitleOpacityControl() {
  const percent = Math.round(resolveSubtitleOpacity() * 100);
  if (subtitleOpacity) {
    subtitleOpacity.value = String(percent);
  }
  if (subtitleOpacityValue) {
    subtitleOpacityValue.value = `${percent}%`;
    subtitleOpacityValue.textContent = `${percent}%`;
  }
}

function resolveSubtitleOpacity() {
  const opacity = Number(layout.subtitle.opacity ?? 1);
  return Number.isFinite(opacity) ? clamp(opacity, minimumSubtitleOpacity, 1) : 1;
}

async function openThreadMenu(clientX, clientY) {
  if (!threadMenu) {
    return;
  }
  threadMenuOpen = true;
  threadMenu.hidden = false;
  setInputPassthrough(false);
  setThreadMenuStatus("読み込み中...");
  positionThreadMenu(clientX, clientY);
  const activeWatcher = state.snapshot?.threadWatchers?.[0];
  const activeThreadId = activeWatcher?.threadId || "";
  threadMenuId.value = activeThreadId || threadMenuId.value || "";
  threadMenuName.value = "";
  try {
    const [, , volume] = await Promise.all([loadThreadMenuProfiles(activeThreadId), refreshFloatingRoleVisibility(), window.codexia.getSpeechVolume()]);
    speechVolume.value = String(volume.volume);
    speechVolumeValue.textContent = `${volume.volume}%`;
    setThreadMenuStatus(activeThreadId ? "現在の実況スレッドを選択中です。" : "");
  } catch (error) {
    setThreadMenuStatus(error instanceof Error ? error.message : String(error));
  }
  threadMenuId.focus();
  threadMenuId.select();
  scheduleFitFloatingWindow();
}

async function refreshFloatingRoleVisibility() {
  try {
    const visibility = await window.codexia?.getFloatingRoleVisibility?.();
    syncFloatingRoleVisibility(visibility);
  } catch {
    syncSubtitleVisibilityControls();
  }
}

function syncFloatingRoleVisibility(visibility) {
  if (typeof visibility?.roles?.subtitle === "boolean") {
    subtitleVisible = visibility.roles.subtitle;
  }
  syncSubtitleVisibilityControls();
}

function syncSubtitleVisibilityControls() {
  if (subtitleVisibleToggle) {
    subtitleVisibleToggle.checked = subtitleVisible;
  }
  if (threadMenuSubtitleVisible) {
    threadMenuSubtitleVisible.checked = subtitleVisible;
  }
}

async function setSubtitleVisible(visible) {
  const previous = subtitleVisible;
  subtitleVisible = Boolean(visible);
  syncSubtitleVisibilityControls();
  setSubtitleVisibilityControlsDisabled(true);
  try {
    const visibility = await window.codexia?.setFloatingRoleVisibility?.({
      role: "subtitle",
      visible: subtitleVisible,
    });
    syncFloatingRoleVisibility(visibility);
    if (showsAvatar) {
      setThreadMenuStatus(subtitleVisible ? "字幕を表示しました。" : "字幕を完全にOFFにしました。");
    }
  } catch (error) {
    subtitleVisible = previous;
    syncSubtitleVisibilityControls();
    if (showsAvatar) {
      setThreadMenuStatus(error instanceof Error ? error.message : String(error));
    }
  } finally {
    setSubtitleVisibilityControlsDisabled(false);
  }
}

function setSubtitleVisibilityControlsDisabled(disabled) {
  if (subtitleVisibleToggle) {
    subtitleVisibleToggle.disabled = disabled;
  }
  if (threadMenuSubtitleVisible) {
    threadMenuSubtitleVisible.disabled = disabled;
  }
}

function closeThreadMenu() {
  if (!threadMenu) {
    return;
  }
  threadMenuOpen = false;
  threadMenu.hidden = true;
  setThreadMenuStatus("");
  updateInputPassthrough();
  scheduleFitFloatingWindow();
}

async function loadThreadMenuProfiles(preferredThreadId = "") {
  const payload = await window.codexia?.getThreadProfiles?.();
  threadMenuProfiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
  renderThreadMenuProfiles(preferredThreadId);
}

function renderThreadMenuProfiles(selectedThreadId = "") {
  if (!threadMenuSelect) {
    return;
  }
  const options = [new Option("手入力", "")];
  for (const profile of threadMenuProfiles) {
    options.push(new Option(threadProfileLabel(profile), profile.threadId));
  }
  threadMenuSelect.replaceChildren(...options);
  const selectedProfile = threadMenuProfiles.find((profile) => profile.threadId === selectedThreadId);
  threadMenuSelect.value = selectedProfile ? selectedProfile.threadId : "";
  if (selectedProfile) {
    threadMenuId.value = selectedProfile.threadId;
    threadMenuName.value = selectedProfile.name || "";
  }
}

async function startThreadFromMenu() {
  const rawThreadId = threadMenuId?.value?.trim() || "";
  if (!rawThreadId) {
    setThreadMenuStatus("スレッドIDを入れてください。");
    return;
  }
  threadMenuStart.disabled = true;
  setThreadMenuStatus("開始しています...");
  try {
    const payload = {
      threadId: rawThreadId,
      replay: "none",
      includeTools: false,
      includeLifecycle: false,
      maxReplayEvents: 0,
    };
    const threadName = threadMenuName?.value?.trim();
    if (threadName) {
      payload.threadName = threadName;
    }
    const result = await window.codexia?.startThreadWatch?.(payload);
    if (result?.watcher?.status === "error") {
      throw new Error(result.watcher.error || "スレッド実況を開始できませんでした。");
    }
    await loadThreadMenuProfiles(result?.profile?.threadId || normalizeThreadIdForUi(rawThreadId));
    setThreadMenuStatus(result?.profile?.name
      ? `「${result.profile.name}」の実況を開始しました。`
      : "実況スレッドを切り替えました。");
  } catch (error) {
    setThreadMenuStatus(error instanceof Error ? error.message : String(error));
  } finally {
    threadMenuStart.disabled = false;
  }
}

function syncThreadMenuProfileFromId() {
  const threadId = normalizeThreadIdForUi(threadMenuId?.value || "");
  const profile = threadMenuProfiles.find((item) => item.threadId === threadId);
  if (threadMenuSelect) {
    threadMenuSelect.value = profile ? profile.threadId : "";
  }
  if (threadMenuName) {
    threadMenuName.value = profile?.name || "";
  }
  setThreadMenuStatus(profile ? "保存済みのスレッドです。" : "");
  if (!profile && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(threadId)) {
    setThreadMenuStatus("スレッド名を確認しています...");
    void window.codexia.lookupThreadName({ threadId }).then((result) => {
      if (normalizeThreadIdForUi(threadMenuId.value) !== threadId || threadMenuName.value.trim()) return;
      if (result?.name) {
        threadMenuName.value = result.name;
        setThreadMenuStatus("スレッド名を取得しました。");
      } else {
        setThreadMenuStatus("スレッド名が見つかりません。名前を入力できます。");
      }
    }).catch(() => {
      if (normalizeThreadIdForUi(threadMenuId.value) === threadId) setThreadMenuStatus("スレッド名を取得できませんでした。");
    });
  }
}

async function saveThreadProfileFromMenu() {
  const rawThreadId = threadMenuId?.value?.trim() || "";
  const threadName = threadMenuName?.value?.trim() || "";
  if (!rawThreadId) {
    setThreadMenuStatus("スレッドIDを入れてください。");
    return;
  }
  if (!threadName) {
    setThreadMenuStatus("保存する名前を入れてください。");
    return;
  }
  threadMenuSave.disabled = true;
  setThreadMenuStatus("保存しています...");
  try {
    const result = await window.codexia?.saveThreadProfile?.({
      threadId: rawThreadId,
      threadName,
    });
    await loadThreadMenuProfiles(result?.profile?.threadId || normalizeThreadIdForUi(rawThreadId));
    setThreadMenuStatus("スレッド名を保存しました。");
  } catch (error) {
    setThreadMenuStatus(error instanceof Error ? error.message : String(error));
  } finally {
    threadMenuSave.disabled = false;
  }
}

function positionThreadMenu(clientX, clientY) {
  if (!threadMenu) {
    return;
  }
  threadMenu.style.left = `${clientX}px`;
  threadMenu.style.top = `${clientY}px`;
  constrainThreadMenu();
  scheduleFitFloatingWindow();
}

function constrainThreadMenu() {
  if (!threadMenu || threadMenu.hidden) {
    return;
  }
  const rect = threadMenu.getBoundingClientRect();
  const margin = 10;
  const left = clamp(rect.left, margin, Math.max(margin, window.innerWidth - rect.width - margin));
  const top = clamp(rect.top, margin, Math.max(margin, window.innerHeight - rect.height - margin));
  threadMenu.style.left = `${Math.round(left)}px`;
  threadMenu.style.top = `${Math.round(top)}px`;
}

function setThreadMenuStatus(message) {
  if (threadMenuStatus) {
    threadMenuStatus.textContent = message;
  }
}

function threadProfileLabel(profile) {
  const shortId = profile.threadId?.length > 12 ? `${profile.threadId.slice(0, 8)}...${profile.threadId.slice(-4)}` : profile.threadId;
  return `${profile.name || "未命名"} / ${shortId || ""}`;
}

function normalizeThreadIdForUi(value) {
  return String(value || "").trim().replace(/^codex:\/\/threads\//i, "");
}

function makeDraggable(element, key) {
  let drag = null;
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragKey = key;
    setInputPassthrough(false);
    pinElement(key);
    const rect = element.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
    };
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const rect = element.getBoundingClientRect();
    const bounds = getMoveBounds(key, rect);
    const left = clamp(event.clientX - drag.dx, bounds.minLeft, bounds.maxLeft);
    const top = clamp(event.clientY - drag.dy, bounds.minTop, bounds.maxTop);
    layout[key].left = Math.round(left);
    layout[key].top = Math.round(top);
    applyLayout();
  });
  element.addEventListener("pointerup", (event) => finishDrag(event));
  element.addEventListener("pointercancel", (event) => finishDrag(event));

  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    drag = null;
    dragKey = null;
    saveLayout();
    updateInputPassthrough(event);
  }
}

function pinElement(key) {
  const element = key === "avatar" ? avatar : subtitle;
  const rect = element.getBoundingClientRect();
  layout[key].left ??= Math.round(rect.left);
  layout[key].top ??= Math.round(rect.top);
  if (key === "avatar") {
    layout.avatar.width ??= Math.round(rect.width);
  } else {
    layout.subtitle.width ??= Math.round(Math.max(rect.width, defaultSubtitleMaxWidthPx));
    layout.subtitle.fontSize ??= Number.parseFloat(getComputedStyle(subtitle).fontSize);
    layout.subtitle.lineHeight ??= Number.parseFloat(getComputedStyle(subtitle).lineHeight) / Number.parseFloat(getComputedStyle(subtitle).fontSize);
  }
}

function applyLayout() {
  constrainPinnedLayout();
  applyElementLayout(avatar, layout.avatar);
  applyElementLayout(subtitle, layout.subtitle);
  if (layout.avatar.width) {
    avatar.style.width = `${layout.avatar.width}px`;
    avatar.style.maxWidth = "none";
  } else {
    avatar.style.width = "";
    avatar.style.maxWidth = "";
  }
  subtitle.style.width = "fit-content";
  subtitle.style.maxWidth = layout.subtitle.width ? `${layout.subtitle.width}px` : "";
  subtitle.style.fontSize = layout.subtitle.fontSize ? `${layout.subtitle.fontSize}px` : "";
  subtitle.style.lineHeight = layout.subtitle.lineHeight ? String(layout.subtitle.lineHeight) : "";
  subtitle.style.opacity = String(resolveSubtitleOpacity());
  if (!fittingWindow) {
    scheduleFitFloatingWindow();
  }
}

function applyElementLayout(element, item) {
  if (typeof item.left === "number" && typeof item.top === "number") {
    element.style.left = `${item.left}px`;
    element.style.top = `${item.top}px`;
    element.style.right = "auto";
    element.style.bottom = "auto";
    return;
  }
  element.style.left = "";
  element.style.top = "";
  element.style.right = "";
  element.style.bottom = "";
}

function constrainPinnedLayout() {
  for (const [key, element] of getActiveElementEntries()) {
    const item = layout[key];
    if (typeof item.left !== "number" || typeof item.top !== "number") {
      continue;
    }
    const rect = element.getBoundingClientRect();
    const bounds = getMoveBounds(key, rect);
    item.left = Math.round(clamp(item.left, bounds.minLeft, bounds.maxLeft));
    item.top = Math.round(clamp(item.top, bounds.minTop, bounds.maxTop));
  }
  if (showsSubtitle && layout.subtitle.width) {
    layout.subtitle.width = Math.round(clamp(layout.subtitle.width, 260, maxSubtitleWidth()));
  }
}

function getMoveBounds(key, rect) {
  if (isCompactWindowEnabled()) {
    return {
      minLeft: -compactMoveSpan,
      maxLeft: compactMoveSpan,
      minTop: -compactMoveSpan,
      maxTop: compactMoveSpan,
    };
  }
  if (key === "subtitle") {
    const minVisibleX = Math.min(subtitleGripPx, window.innerWidth);
    const minVisibleY = Math.min(64, window.innerHeight);
    return {
      minLeft: Math.min(0, minVisibleX - rect.width),
      maxLeft: Math.max(0, window.innerWidth - minVisibleX),
      minTop: Math.min(0, minVisibleY - rect.height),
      maxTop: Math.max(0, window.innerHeight - minVisibleY),
    };
  }
  return {
    minLeft: 0,
    maxLeft: Math.max(0, window.innerWidth - rect.width),
    minTop: 0,
    maxTop: Math.max(0, window.innerHeight - rect.height),
  };
}

function isCompactWindowEnabled() {
  return Boolean(window.codexia?.setFloatingWindowBounds);
}

function scheduleFitFloatingWindow() {
  if (!isCompactWindowEnabled() || fitWindowFrame) {
    return;
  }
  fitWindowFrame = requestAnimationFrame(() => {
    fitWindowFrame = 0;
    fitFloatingWindowToContent();
  });
}

function fitFloatingWindowToContent() {
  if (!isCompactWindowEnabled()) {
    return;
  }
  if (!compactWindowReady) {
    const activeEntries = getActiveElementEntries();
    const activeRects = activeEntries.map(([, element]) => element.getBoundingClientRect());
    if (activeRects.length === 0 || activeRects.some((rect) => rect.width < 1 || rect.height < 1)) {
      return;
    }
    for (const [key] of activeEntries) {
      pinElement(key);
    }
    compactWindowReady = true;
    fittingWindow = true;
    applyLayout();
    fittingWindow = false;
  }

  let rects = getFloatingContentRects();
  if (rects.length === 0) {
    return;
  }
  let union = unionRects(rects);
  const shiftX = Math.floor(union.left - compactWindowMargin);
  const shiftY = Math.floor(union.top - compactWindowMargin);
  if (shiftX !== 0 || shiftY !== 0) {
    shiftPinnedLayout(shiftX, shiftY);
    fittingWindow = true;
    applyLayout();
    fittingWindow = false;
    rects = getFloatingContentRects();
    if (rects.length === 0) {
      return;
    }
    union = unionRects(rects);
  }

  const bounds = {
    x: Math.round(window.screenX + shiftX),
    y: Math.round(window.screenY + shiftY),
    width: Math.ceil(union.width + compactWindowMargin * 2),
    height: Math.ceil(union.height + compactWindowMargin * 2),
  };
  const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
  if (key === lastFloatingBoundsKey) {
    return;
  }
  lastFloatingBoundsKey = key;
  window.codexia.setFloatingWindowBounds(bounds);
}

function getFloatingContentRects() {
  const elements = getActiveElementEntries().map(([, element]) => element);
  if (showsAvatar && threadMenuOpen && threadMenu && !threadMenu.hidden) {
    elements.push(threadMenu);
  }
  if (showsSubtitle && subtitleMenuOpen && subtitleMenu && !subtitleMenu.hidden) {
    elements.push(subtitleMenu);
  }
  return elements
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 1 && rect.height > 1);
}

function unionRects(rects) {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function shiftPinnedLayout(shiftX, shiftY) {
  for (const key of getActiveElementEntries().map(([entryKey]) => entryKey)) {
    const item = layout[key];
    if (typeof item.left === "number") {
      item.left -= shiftX;
    }
    if (typeof item.top === "number") {
      item.top -= shiftY;
    }
  }
  if (showsAvatar && threadMenuOpen && threadMenu && !threadMenu.hidden) {
    threadMenu.style.left = `${Math.round(threadMenu.offsetLeft - shiftX)}px`;
    threadMenu.style.top = `${Math.round(threadMenu.offsetTop - shiftY)}px`;
  }
  if (showsSubtitle && subtitleMenuOpen && subtitleMenu && !subtitleMenu.hidden) {
    subtitleMenu.style.left = `${Math.round(subtitleMenu.offsetLeft - shiftX)}px`;
    subtitleMenu.style.top = `${Math.round(subtitleMenu.offsetTop - shiftY)}px`;
  }
}

function getActiveElementEntries() {
  const entries = [];
  if (showsAvatar) {
    entries.push(["avatar", avatar]);
  }
  if (showsSubtitle) {
    entries.push(["subtitle", subtitle]);
  }
  return entries;
}

function normalizeFloatingRole(value) {
  return value === "avatar" || value === "subtitle" ? value : "combined";
}

function maxSubtitleWidth() {
  const availableScreenWidth = Number(window.screen?.availWidth);
  if (Number.isFinite(availableScreenWidth) && availableScreenWidth > compactWindowMargin * 2) {
    return Math.max(260, availableScreenWidth - compactWindowMargin * 2);
  }
  return Math.max(260, window.innerWidth - 16);
}

function wheelDirection(event) {
  return event.deltaY < 0 ? 1 : -1;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadLayout() {
  try {
    const parsed = JSON.parse(localStorage.getItem(layoutStoreKey) || "{}");
    return {
      avatar: isObject(parsed.avatar) ? parsed.avatar : {},
      subtitle: isObject(parsed.subtitle) ? parsed.subtitle : {},
    };
  } catch {
    return { avatar: {}, subtitle: {} };
  }
}

function saveLayout() {
  localStorage.setItem(layoutStoreKey, JSON.stringify(layout));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function renderSubtitleText(text) {
  if (subtitle.dataset.text === text) {
    return;
  }
  subtitle.dataset.text = text;
  subtitle.setAttribute("aria-label", text);
  const outer = document.createElement("span");
  outer.className = "subtitle-layer subtitle-layer-outer";
  outer.setAttribute("aria-hidden", "true");
  appendSubtitleLayerText(outer, text);
  const white = document.createElement("span");
  white.className = "subtitle-layer subtitle-layer-white";
  white.setAttribute("aria-hidden", "true");
  appendSubtitleLayerText(white, text);
  const fill = document.createElement("span");
  fill.className = "subtitle-layer subtitle-layer-fill";
  fill.setAttribute("aria-hidden", "true");
  appendSubtitleLayerText(fill, text);
  subtitle.replaceChildren(outer, white, fill);
}

function appendSubtitleLayerText(layer, text) {
  const segments = subtitleGraphemeSegmenter
    ? Array.from(subtitleGraphemeSegmenter.segment(text), (entry) => entry.segment)
    : Array.from(text);
  let plainText = "";
  const flushPlainText = () => {
    if (plainText) {
      layer.append(document.createTextNode(plainText));
      plainText = "";
    }
  };
  for (const segment of segments) {
    if (!subtitleEmojiPattern.test(segment)) {
      plainText += segment;
      continue;
    }
    flushPlainText();
    const emoji = document.createElement("span");
    emoji.className = "subtitle-emoji";
    emoji.textContent = segment;
    layer.append(emoji);
  }
  flushPlainText();
}

function updateInputPassthrough(event) {
  if (threadMenuOpen || subtitleMenuOpen) {
    setInputPassthrough(false);
    return;
  }
  if (dragKey) {
    setInputPassthrough(false);
    return;
  }
  if (!event) {
    setInputPassthrough(true);
    return;
  }
  const target = document.elementFromPoint(event.clientX, event.clientY);
  const interactive = Boolean(target?.closest?.(".floating-avatar, .floating-subtitle, .thread-menu, .subtitle-menu"));
  setInputPassthrough(!interactive);
}

function setInputPassthrough(passthrough) {
  if (inputPassthrough === passthrough) {
    return;
  }
  inputPassthrough = passthrough;
  window.codexia?.setFloatingInputPassthrough?.(passthrough);
}
