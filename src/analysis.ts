import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { analysisJsonlPath } from "./paths.js";
import type { AnalysisEvent, ProgressEventRecord } from "./types.js";

const successPattern = /成功|完了|通りました|できました|OK|PASS|よし|大丈夫/i;
const errorPattern = /エラー|失敗|例外|落ち(?!着)|壊れ|クラッシュ|fatal|error|failed|crash/i;
const warningPattern = /警告|危険|注意|避け|不安|リスク|warning/i;
const waitingPattern = /確認しています|調査|待機|準備|処理中|読み込み|見ています/i;
const surprisePattern = /えっ|びっくり|驚|まさか|想定外/i;
const shyPattern = /照れ|えっち|色っぽ|からか|あわあわ|視線/i;

export async function analyzeAndPersist(event: ProgressEventRecord): Promise<AnalysisEvent> {
  const analysis = analyzeEvent(event);
  await mkdir(dirname(analysisJsonlPath), { recursive: true });
  await appendFile(analysisJsonlPath, `${JSON.stringify(analysis, null, 0)}\n`, "utf8");
  return analysis;
}

export function analyzeEvent(event: ProgressEventRecord): AnalysisEvent {
  const text = event.text;
  const lowerKind = event.kind;
  let emotion: AnalysisEvent["emotion"] = "focused";
  let intensity = 0.52;
  let gesture = "small_nod";
  let reason = "default focused progress reading";
  let layers: AnalysisEvent["layers"] = {
    mouth: "*ほほえみ",
    eyes: "*目セット",
    brows: "*太眉ごきげん",
    faceColor: "*普通2",
    extras: [],
  };

  if (lowerKind === "error" || errorPattern.test(text)) {
    emotion = "error";
    intensity = 0.82;
    gesture = "retreat";
    reason = "error or failure cue";
    layers = {
      mouth: "*困る",
      eyes: "*目セット",
      brows: "*太眉困り",
      faceColor: "*青ざめ",
      extras: ["safe_non_explicit"],
    };
  } else if (lowerKind === "warning" || warningPattern.test(text)) {
    emotion = "warning";
    intensity = 0.72;
    gesture = "head_tilt";
    reason = "warning or risk cue";
    layers = {
      mouth: "*ほほえみ",
      eyes: "*目セット",
      brows: "*太眉困り",
      faceColor: "*普通2",
      extras: [],
    };
  } else if (lowerKind === "success" || successPattern.test(text)) {
    emotion = "success";
    intensity = 0.74;
    gesture = "small_nod";
    reason = "success keyword and low urgency";
    layers = {
      mouth: "*わあー",
      eyes: "*目セット",
      brows: "*太眉ごきげん",
      faceColor: "*普通2",
      extras: [],
    };
  } else if (shyPattern.test(text)) {
    emotion = "shy_flirty";
    intensity = 0.58;
    gesture = "look_away";
    reason = "safe shy or teasing cue, explicit direction blocked";
    layers = {
      mouth: "*ほほえみ",
      eyes: "*目セット",
      brows: "*太眉困り",
      faceColor: "*照れ",
      extras: ["explicit_blocked", "safe_teasing_only"],
    };
  } else if (surprisePattern.test(text)) {
    emotion = "surprise";
    intensity = 0.66;
    gesture = "lean_in";
    reason = "surprise cue";
    layers = {
      mouth: "*わあー",
      eyes: "*目セット",
      brows: "*太眉びっくり",
      faceColor: "*普通2",
      extras: [],
    };
  } else if (waitingPattern.test(text)) {
    emotion = "focused";
    intensity = 0.6;
    gesture = "idle_focus";
    reason = "investigation or in-progress cue";
  }

  return {
    schemaVersion: 1,
    timestamp: toJstIso(new Date()),
    threadId: event.threadId,
    source: event.source,
    text,
    analysisProvider: "rules",
    analysisModel: "rules-v0",
    emotion,
    emotionIntensity: intensity,
    stance: "helpful",
    gesture,
    voice: {
      speaker: "四国めたん",
      styleId: 2,
      speedScale: 1,
      pitchScale: 0,
      intonationScale: 1,
    },
    layers,
    reason,
    userCorrection: null,
  };
}

function toJstIso(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace("Z", "+09:00");
}
