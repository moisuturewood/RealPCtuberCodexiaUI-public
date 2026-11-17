import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const srcDir = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(srcDir, "..");
export const publicDir = join(projectRoot, "public");
export const scriptsDir = join(projectRoot, "scripts");
export const configDir = join(projectRoot, "config");
export const audioOutputDir = join(projectRoot, "outputs", "audio");
export const analysisJsonlPath = join(projectRoot, "data", "analysis", "events.jsonl");
export const threadProfilesPath = join(configDir, "thread-profiles.json");
export const pronunciationCandidatesPath = join(configDir, "pronunciation-candidates.json");
export const voicevoxSettingsPath = join(configDir, "voicevox-settings.json");
export const floatingOverlaySettingsPath = join(configDir, "floating-overlay-settings.json");

const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
export const codexSessionIndexPath =
  process.env.CODEX_SESSION_INDEX_PATH ?? join(codexHome, "session_index.jsonl");

const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
const voicevoxDataDir = join(localAppData, "VOICEVOX");
export const voicevoxCoreRoot =
  process.env.VOICEVOX_CORE_ROOT ?? join(voicevoxDataDir, "Core");

export const openJtalkRoot =
  process.env.OPENJTALK_ROOT ?? join(voicevoxDataDir, "OpenJTalkDic");

export const avatarBridgeRoot = process.env.VOICEVOX_AVATAR_BRIDGE_ROOT ??
  join(projectRoot, "assets", "voicevox-avatar-bridge");

export const avatarRenderedDir = join(avatarBridgeRoot, "runtime", "rendered");
