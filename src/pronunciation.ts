import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { pronunciationCandidatesPath } from "./paths.js";

const builtInPronunciationEntries: Array<[string, string]> = [
  ["API", "エーピーアイ"],
  ["Codexia", "コーデクシア"],
  ["Elin", "エリン"],
  ["GET", "ゲット"],
  ["HTTP", "エイチティーティーピー"],
  ["HTTPS", "エイチティーティーピーエス"],
  ["JSONL", "ジェイソンエル"],
  ["POST", "ポスト"],
  ["PSD", "ピーエスディー"],
  ["RealPCtuber", "リアルピーシーチューバー"],
  ["UI", "ユーアイ"],
  ["URL", "ユーアールエル"],
  ["VOICEVOX", "ボイスボックス"],
  ["WAV", "ウェーブ"],
  ["Windows", "ウィンドウズ"],
  ["agent", "エージェント"],
  ["agent_message", "エージェントメッセージ"],
  ["commentary", "コメンタリー"],
  ["clu", "クルー"],
  ["de", "ド"],
  ["design", "デザイン"],
  ["false", "フォルス"],
  ["in", "イン"],
  ["include", "インクルード"],
  ["includeLifecycle", "インクルードライフサイクル"],
  ["includeTools", "インクルードツールズ"],
  ["input", "インプット"],
  ["inside", "インサイド"],
  ["itemType", "アイテムタイプ"],
  ["lifecycle", "ライフサイクル"],
  ["message", "メッセージ"],
  ["none", "なし"],
  ["put", "プット"],
  ["push", "プッシュ"],
  ["replay", "リプレイ"],
  ["side", "サイド"],
  ["threadId", "スレッドアイディー"],
  ["true", "トゥルー"],
  ["type", "タイプ"],
  ["tools", "ツールズ"],
  ["watcher", "ウォッチャー"],
  ["watching", "ウォッチング"],
];

const commonEnglishKatakanaEntries: Array<[string, string]> = [
  ["accent", "アクセント"],
  ["accentphrase", "アクセントフレーズ"],
  ["adapter", "アダプター"],
  ["audio", "オーディオ"],
  ["audioquery", "オーディオクエリー"],
  ["avatar", "アバター"],
  ["browser", "ブラウザー"],
  ["build", "ビルド"],
  ["button", "ボタン"],
  ["cache", "キャッシュ"],
  ["check", "チェック"],
  ["click", "クリック"],
  ["client", "クライアント"],
  ["code", "コード"],
  ["command", "コマンド"],
  ["config", "コンフィグ"],
  ["core", "コア"],
  ["data", "データ"],
  ["default", "デフォルト"],
  ["detail", "ディテール"],
  ["direct", "ダイレクト"],
  ["electron", "エレクトロン"],
  ["engine", "エンジン"],
  ["event", "イベント"],
  ["events", "イベント"],
  ["export", "エクスポート"],
  ["file", "ファイル"],
  ["final", "ファイナル"],
  ["font", "フォント"],
  ["frame", "フレーム"],
  ["game", "ゲーム"],
  ["import", "インポート"],
  ["input", "インプット"],
  ["job", "ジョブ"],
  ["layout", "レイアウト"],
  ["local", "ローカル"],
  ["log", "ログ"],
  ["model", "モデル"],
  ["node", "ノード"],
  ["output", "アウトプット"],
  ["panel", "パネル"],
  ["path", "パス"],
  ["play", "プレイ"],
  ["playback", "プレイバック"],
  ["plugin", "プラグイン"],
  ["preset", "プリセット"],
  ["profile", "プロフィール"],
  ["phrase", "フレーズ"],
  ["query", "クエリー"],
  ["render", "レンダー"],
  ["replay", "リプレイ"],
  ["request", "リクエスト"],
  ["reset", "リセット"],
  ["response", "レスポンス"],
  ["rhythm", "リズム"],
  ["runtime", "ランタイム"],
  ["script", "スクリプト"],
  ["server", "サーバー"],
  ["speech", "スピーチ"],
  ["start", "スタート"],
  ["state", "ステート"],
  ["status", "ステータス"],
  ["style", "スタイル"],
  ["subtitle", "サブタイトル"],
  ["summary", "サマリー"],
  ["synthesis", "シンセシス"],
  ["synthesize", "シンセサイズ"],
  ["system", "システム"],
  ["text", "テキスト"],
  ["thread", "スレッド"],
  ["token", "トークン"],
  ["type", "タイプ"],
  ["unknown", "アンノウン"],
  ["version", "バージョン"],
  ["voice", "ボイス"],
  ["watch", "ウォッチ"],
  ["worker", "ワーカー"],
  ["world", "ワールド"],
];

const commonEnglishKatakanaMap = new Map(commonEnglishKatakanaEntries);

const letterNameReadings = new Map<string, string>([
  ["a", "エー"],
  ["b", "ビー"],
  ["c", "シー"],
  ["d", "ディー"],
  ["e", "イー"],
  ["f", "エフ"],
  ["g", "ジー"],
  ["h", "エイチ"],
  ["i", "アイ"],
  ["j", "ジェー"],
  ["k", "ケー"],
  ["l", "エル"],
  ["m", "エム"],
  ["n", "エヌ"],
  ["o", "オー"],
  ["p", "ピー"],
  ["q", "キュー"],
  ["r", "アール"],
  ["s", "エス"],
  ["t", "ティー"],
  ["u", "ユー"],
  ["v", "ブイ"],
  ["w", "ダブリュー"],
  ["x", "エックス"],
  ["y", "ワイ"],
  ["z", "ゼット"],
]);

const letterNameReadingParts = [...letterNameReadings.values(), "アンダーバー"].sort((left, right) => right.length - left.length);

const vowelReadings = new Map<string, string>([
  ["a", "ア"],
  ["i", "イ"],
  ["u", "ウ"],
  ["e", "エ"],
  ["o", "オ"],
  ["y", "イ"],
]);

const consonantFallbackReadings = new Map<string, string>([
  ["b", "ブ"],
  ["c", "ク"],
  ["d", "ド"],
  ["f", "フ"],
  ["g", "グ"],
  ["h", "ハ"],
  ["j", "ジ"],
  ["k", "ク"],
  ["l", "ル"],
  ["m", "ム"],
  ["n", "ン"],
  ["p", "プ"],
  ["q", "ク"],
  ["r", "ル"],
  ["s", "ス"],
  ["t", "ト"],
  ["v", "ブ"],
  ["w", "ウ"],
  ["x", "クス"],
  ["z", "ズ"],
]);

const consonantVowelReadings = new Map<string, string>([
  ["ba", "バ"], ["bi", "ビ"], ["bu", "ブ"], ["be", "ベ"], ["bo", "ボ"], ["by", "ビ"],
  ["ca", "カ"], ["ci", "シ"], ["cu", "ク"], ["ce", "セ"], ["co", "コ"], ["cy", "シ"],
  ["da", "ダ"], ["di", "ディ"], ["du", "ドゥ"], ["de", "デ"], ["do", "ド"], ["dy", "ディ"],
  ["fa", "ファ"], ["fi", "フィ"], ["fu", "フ"], ["fe", "フェ"], ["fo", "フォ"], ["fy", "フィ"],
  ["ga", "ガ"], ["gi", "ギ"], ["gu", "グ"], ["ge", "ゲ"], ["go", "ゴ"], ["gy", "ギ"],
  ["ha", "ハ"], ["hi", "ヒ"], ["hu", "フ"], ["he", "ヘ"], ["ho", "ホ"], ["hy", "ヒ"],
  ["ja", "ジャ"], ["ji", "ジ"], ["ju", "ジュ"], ["je", "ジェ"], ["jo", "ジョ"], ["jy", "ジ"],
  ["ka", "カ"], ["ki", "キ"], ["ku", "ク"], ["ke", "ケ"], ["ko", "コ"], ["ky", "キ"],
  ["la", "ラ"], ["li", "リ"], ["lu", "ル"], ["le", "レ"], ["lo", "ロ"], ["ly", "リ"],
  ["ma", "マ"], ["mi", "ミ"], ["mu", "ム"], ["me", "メ"], ["mo", "モ"], ["my", "ミ"],
  ["na", "ナ"], ["ni", "ニ"], ["nu", "ヌ"], ["ne", "ネ"], ["no", "ノ"], ["ny", "ニ"],
  ["pa", "パ"], ["pi", "ピ"], ["pu", "プ"], ["pe", "ペ"], ["po", "ポ"], ["py", "ピ"],
  ["ra", "ラ"], ["ri", "リ"], ["ru", "ル"], ["re", "レ"], ["ro", "ロ"], ["ry", "リ"],
  ["sa", "サ"], ["si", "シ"], ["su", "ス"], ["se", "セ"], ["so", "ソ"], ["sy", "シ"],
  ["ta", "タ"], ["ti", "ティ"], ["tu", "トゥ"], ["te", "テ"], ["to", "ト"], ["ty", "ティ"],
  ["va", "バ"], ["vi", "ビ"], ["vu", "ブ"], ["ve", "ベ"], ["vo", "ボ"], ["vy", "ビ"],
  ["wa", "ワ"], ["wi", "ウィ"], ["wu", "ウ"], ["we", "ウェ"], ["wo", "ウォ"], ["wy", "ウィ"],
  ["za", "ザ"], ["zi", "ジ"], ["zu", "ズ"], ["ze", "ゼ"], ["zo", "ゾ"], ["zy", "ジ"],
]);

const englishChunkReadings: ReadonlyArray<readonly [string, string]> = ([
  ["tion", "ション"],
  ["sion", "ション"],
  ["ture", "チャー"],
  ["sure", "ジャー"],
  ["ough", "オー"],
  ["augh", "オー"],
  ["eigh", "エイ"],
  ["igh", "アイ"],
  ["air", "エア"],
  ["ear", "イア"],
  ["eer", "イア"],
  ["oo", "ウー"],
  ["ee", "イー"],
  ["ea", "イー"],
  ["ai", "エイ"],
  ["ay", "エイ"],
  ["oa", "オー"],
  ["oi", "オイ"],
  ["oy", "オイ"],
  ["ou", "アウ"],
  ["ow", "オウ"],
  ["au", "オー"],
  ["aw", "オー"],
  ["ph", "フ"],
  ["ch", "チ"],
  ["sh", "シ"],
  ["th", "ス"],
  ["wh", "ホ"],
  ["qu", "ク"],
  ["ck", "ック"],
  ["ng", "ング"],
] as const).slice().sort(([left], [right]) => right.length - left.length);

const romanTokenPattern = /(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]*(?:[.+#-][A-Za-z0-9_]+)*)(?![A-Za-z0-9_])/g;
const globalPronunciationMapPath =
  process.env.CEVIO_SASARA_GLOBAL_PRONUNCIATION_MAP ??
  join(resolveCodexHome(), "cevio-sasara-tts", "global-pronunciation-map.json");
const sharedPronunciationCandidatesPath =
  process.env.CEVIO_SASARA_PRONUNCIATION_CANDIDATES ??
  join(resolveCodexHome(), "cevio-sasara-tts", "pronunciation-candidates.json");

interface PronunciationResources {
  cacheKey: string;
  entries: PronunciationEntry[];
  exactMap: Map<string, string>;
  fragmentEntries: ReadonlyArray<readonly [string, string]>;
}

interface PronunciationEntry {
  token: string;
  reading: string;
}

interface PronunciationResult {
  reading: string;
  isAutoKatakana: boolean;
}

interface PronunciationCandidate {
  token: string;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
  source: string;
  sample: string;
  suggestedReading?: string;
}

let cachedResources: PronunciationResources | null = null;

export function normalizeForSpeech(input: string): string {
  const resources = loadPronunciationResources();
  const pronunciationCandidates = new Map<string, string | null>();
  const mappedInput = replaceKnownPronunciations(input, resources.entries);
  const converted = mappedInput.replace(romanTokenPattern, (token) => {
    const pronunciation = pronunciationForToken(token, resources);
    if (pronunciation) {
      if (pronunciation.isAutoKatakana) {
        pronunciationCandidates.set(token, pronunciation.reading);
      }
      return pronunciation.reading;
    }
    pronunciationCandidates.set(token, null);
    return token;
  });
  recordUnknownPronunciationCandidates(pronunciationCandidates, input, "voicevox-metan");
  return converted;
}

function loadPronunciationResources(): PronunciationResources {
  const cacheKey = getPronunciationCacheKey();
  if (cachedResources?.cacheKey === cacheKey) {
    return cachedResources;
  }

  const exactMap = new Map<string, string>();
  for (const [token, reading] of builtInPronunciationEntries) {
    exactMap.set(token.toLowerCase(), reading);
  }
  for (const [token, reading] of readGlobalPronunciationEntries()) {
    exactMap.set(token.toLowerCase(), reading);
  }

  const entries = [...exactMap.entries()]
    .map(([token, reading]) => ({ token, reading }))
    .sort((left, right) => right.token.length - left.token.length);
  const fragmentEntries = entries
    .filter(({ token }) => /^[a-z]+$/.test(token) && token.length >= 2)
    .map(({ token, reading }) => [token, reading] as const)
    .sort(([left], [right]) => right.length - left.length);

  cachedResources = { cacheKey, exactMap, entries, fragmentEntries };
  return cachedResources;
}

function getPronunciationCacheKey(): string {
  if (!existsSync(globalPronunciationMapPath)) {
    return "missing";
  }
  try {
    const fileStat = statSync(globalPronunciationMapPath);
    return `${globalPronunciationMapPath}:${fileStat.mtimeMs}:${fileStat.size}`;
  } catch {
    return "unreadable";
  }
}

function readGlobalPronunciationEntries(): Array<[string, string]> {
  if (!existsSync(globalPronunciationMapPath)) {
    return [];
  }
  try {
    const content = readFileSync(globalPronunciationMapPath, "utf8").replace(/^\uFEFF/u, "");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string")
      .filter(([token, reading]) => token.trim() !== "" && reading.trim() !== "")
      .filter(([token, reading]) => !isLikelyBadLetterNamePronunciation(token, reading));
  } catch {
    return [];
  }
}

function isLikelyBadLetterNamePronunciation(token: string, reading: string): boolean {
  const cleanToken = token.trim();
  const latinLength = cleanToken.replace(/[^A-Za-z]/g, "").length;
  if (!/^[A-Za-z0-9_.+#-]+$/.test(cleanToken) || latinLength < 3 || !/[a-z]/.test(cleanToken)) {
    return false;
  }
  let rest = reading.trim();
  while (rest) {
    const part = letterNameReadingParts.find((item) => rest.startsWith(item));
    if (!part) {
      return false;
    }
    rest = rest.slice(part.length);
  }
  return true;
}

function replaceKnownPronunciations(input: string, entries: PronunciationEntry[]): string {
  let converted = input;
  for (const { token, reading } of entries) {
    if (!token.trim()) {
      continue;
    }
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(token)}(?![A-Za-z0-9_])`, "gi");
    converted = converted.replace(pattern, reading);
  }
  return converted;
}

function pronunciationForToken(token: string, resources: PronunciationResources): PronunciationResult | null {
  const exact = resources.exactMap.get(token.toLowerCase());
  if (exact) {
    return { reading: exact, isAutoKatakana: false };
  }

  const parts = splitCamelCaseToken(token);
  if (parts.length > 1) {
    const readings = parts.map((part) => {
      const key = part.toLowerCase();
      return resources.exactMap.get(key) ?? commonEnglishKatakanaMap.get(key);
    });
    if (readings.every(Boolean)) {
      return { reading: readings.join(""), isAutoKatakana: false };
    }
  }

  const commonEnglishReading = commonEnglishKatakanaMap.get(token.toLowerCase());
  if (commonEnglishReading) {
    return { reading: commonEnglishReading, isAutoKatakana: true };
  }

  const fragmentReading = pronunciationFromFragments(token, resources.fragmentEntries);
  if (fragmentReading) {
    return { reading: fragmentReading, isAutoKatakana: false };
  }

  const autoKatakana = katakanaForEnglishToken(token);
  return autoKatakana ? { reading: autoKatakana, isAutoKatakana: true } : null;
}

function pronunciationFromFragments(
  token: string,
  fragmentEntries: ReadonlyArray<readonly [string, string]>,
): string | null {
  if (!/^[A-Za-z]+$/.test(token)) {
    return null;
  }
  const lowerToken = token.toLowerCase();
  const readings: string[] = [];
  let index = 0;
  while (index < lowerToken.length) {
    const match = fragmentEntries.find(([fragment]) => lowerToken.startsWith(fragment, index));
    if (!match) {
      return null;
    }
    readings.push(match[1]);
    index += match[0].length;
  }
  return readings.join("");
}

function splitCamelCaseToken(token: string): string[] {
  return token.split("_").flatMap((part) =>
    part
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function katakanaForEnglishToken(token: string): string | null {
  if (!/[A-Za-z]/.test(token) || /[0-9]/.test(token)) {
    return null;
  }

  const separatorParts = token.split(/[._+#-]+/).filter(Boolean);
  if (separatorParts.length > 1) {
    const readings = separatorParts.map(katakanaForEnglishToken);
    return readings.every(Boolean) ? readings.join("、") : null;
  }

  const camelParts = splitCamelCaseToken(token);
  if (camelParts.length > 1) {
    const readings = camelParts.map(katakanaForEnglishToken);
    return readings.every(Boolean) ? readings.join("") : null;
  }

  if (!/^[A-Za-z]+$/.test(token)) {
    return null;
  }

  const lowerToken = token.toLowerCase();
  const common = commonEnglishKatakanaMap.get(lowerToken);
  if (common) {
    return common;
  }

  if (/^[A-Z]{2,8}$/.test(token) || !/[aeiouy]/i.test(token)) {
    return spellLettersAsJapanese(lowerToken);
  }

  return katakanaForEnglishWord(lowerToken);
}

function spellLettersAsJapanese(lowerToken: string): string {
  return [...lowerToken]
    .map((letter) => letterNameReadings.get(letter) ?? letter)
    .join("");
}

function katakanaForEnglishWord(word: string): string {
  const normalized = word.replace(/(.)\1+/g, "$1$1");
  const readings: string[] = [];
  let index = 0;
  while (index < normalized.length) {
    const chunk = englishChunkReadings.find(([text]) => normalized.startsWith(text, index));
    if (chunk) {
      readings.push(chunk[1]);
      index += chunk[0].length;
      continue;
    }

    const current = normalized[index] ?? "";
    const next = normalized[index + 1] ?? "";
    const pair = `${current}${next}`;
    const pairReading = consonantVowelReadings.get(pair);
    if (pairReading) {
      readings.push(pairReading);
      index += 2;
      continue;
    }

    if (current === "e" && index === normalized.length - 1 && readings.length > 0) {
      index += 1;
      continue;
    }

    if (current === "r" && readings.length > 0 && (index === normalized.length - 1 || !isEnglishVowel(next))) {
      readings.push("ー");
      index += 1;
      continue;
    }

    const vowelReading = vowelReadings.get(current);
    if (vowelReading) {
      readings.push(vowelReading);
      index += 1;
      continue;
    }

    const consonantReading = consonantFallbackReadings.get(current);
    if (consonantReading) {
      readings.push(consonantReading);
      index += 1;
      continue;
    }

    readings.push(current);
    index += 1;
  }
  return tidyKatakana(readings.join(""));
}

function tidyKatakana(value: string): string {
  return value
    .replace(/ッック/g, "ック")
    .replace(/フォオ/g, "フォー")
    .replace(/ーー+/g, "ー")
    .replace(/ウーア/g, "ワ")
    .replace(/ウーイ/g, "ウィ")
    .replace(/ウーエ/g, "ウェ")
    .replace(/ウーオ/g, "ウォ");
}

function isEnglishVowel(value: string): boolean {
  return value === "a" || value === "i" || value === "u" || value === "e" || value === "o" || value === "y";
}

function recordUnknownPronunciationCandidates(candidates: Map<string, string | null>, sample: string, source: string): void {
  const uniqueCandidates = new Map<string, string | null>();
  for (const [token, suggestedReading] of candidates) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }
    uniqueCandidates.set(trimmed, suggestedReading);
  }
  if (uniqueCandidates.size === 0) {
    return;
  }
  writePronunciationCandidates(pronunciationCandidatesPath, uniqueCandidates, sample, source);
  writePronunciationCandidates(sharedPronunciationCandidatesPath, uniqueCandidates, sample, source);
}

function writePronunciationCandidates(path: string, candidatesToWrite: Map<string, string | null>, sample: string, source: string): void {
  try {
    const now = new Date().toISOString();
    const current = readPronunciationCandidates(path);
    const byKey = new Map(current.map((candidate) => [candidate.token.toLowerCase(), candidate]));
    for (const [token, suggestedReading] of candidatesToWrite) {
      const key = token.toLowerCase();
      const previous = byKey.get(key);
      if (previous) {
        previous.lastSeenAt = now;
        previous.count += 1;
        previous.sample = compactSample(sample);
        if (suggestedReading) {
          previous.suggestedReading = suggestedReading;
        }
        continue;
      }
      const candidate: PronunciationCandidate = {
        token,
        firstSeenAt: now,
        lastSeenAt: now,
        count: 1,
        source,
        sample: compactSample(sample),
      };
      if (suggestedReading) {
        candidate.suggestedReading = suggestedReading;
      }
      byKey.set(key, candidate);
    }
    const candidates = [...byKey.values()].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ schemaVersion: 1, updatedAt: now, candidates }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Pronunciation candidates are advisory. Speech should never fail because this local note could not be written.
  }
}

function readPronunciationCandidates(path: string): PronunciationCandidate[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, "")) as { candidates?: unknown };
    if (!Array.isArray(parsed.candidates)) {
      return [];
    }
    return parsed.candidates
      .map(sanitizePronunciationCandidate)
      .filter((candidate): candidate is PronunciationCandidate => Boolean(candidate));
  } catch {
    return [];
  }
}

function sanitizePronunciationCandidate(value: unknown): PronunciationCandidate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.token !== "string" || record.token.trim() === "") {
    return null;
  }
  const now = new Date().toISOString();
  return {
    token: record.token.trim(),
    firstSeenAt: typeof record.firstSeenAt === "string" ? record.firstSeenAt : now,
    lastSeenAt: typeof record.lastSeenAt === "string" ? record.lastSeenAt : now,
    count: typeof record.count === "number" && Number.isFinite(record.count) ? Math.max(1, Math.floor(record.count)) : 1,
    source: typeof record.source === "string" && record.source.trim() ? record.source : "voicevox-metan",
    sample: typeof record.sample === "string" ? compactSample(record.sample) : "",
    suggestedReading: typeof record.suggestedReading === "string" && record.suggestedReading.trim()
      ? record.suggestedReading.trim()
      : undefined,
  };
}

function compactSample(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const chars = [...normalized];
  return chars.length <= 180 ? normalized : `${chars.slice(0, 179).join("")}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? "", ".codex");
}
