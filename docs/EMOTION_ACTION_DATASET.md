# Emotion And Action Dataset Plan

## Goal

Collect high-quality mappings from text to avatar action so a future small model can learn the role.

## JSONL Path

```text
data/analysis/events.jsonl
```

## Record Shape

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-06-27T00:00:00+09:00",
  "threadId": "codex://threads/example",
  "source": "codex-progress",
  "text": "ビルドが通りました。次に表示確認します。",
  "analysisProvider": "rules",
  "analysisModel": "rules-v0",
  "emotion": "success",
  "emotionIntensity": 0.7,
  "stance": "helpful",
  "gesture": "small_nod",
  "voice": {
    "speaker": "四国めたん",
    "styleId": 2,
    "speedScale": 1.0,
    "pitchScale": 0.0,
    "intonationScale": 1.0
  },
  "layers": {
    "mouth": "*ほほえみ",
    "eyes": "*目セット",
    "brows": "*太眉ごきげん",
    "faceColor": "*普通2",
    "extras": []
  },
  "reason": "success keyword and low urgency",
  "userCorrection": null
}
```

## Detailed Training Record Proposal

Spark analysis should emit a detailed record that can later become a supervised dataset for a small selector model.

```json
{
  "schemaVersion": "metan-anim-v1",
  "recordId": "uuid",
  "sessionId": "uuid",
  "timestampJst": "2026-06-27T12:34:56+09:00",
  "input": {
    "locale": "ja-JP",
    "rawLogText": "string",
    "logStage": ["codex_progress", "user_text", "system_event"],
    "psdBundleId": "string",
    "availableLayerIds": ["id_1"]
  },
  "analysis": {
    "methodChain": ["rule", "spark_fallback"],
    "rulePass": {
      "matchedRules": [{ "ruleId": "string", "hit": true, "weight": 0.0 }],
      "selectedByRule": true
    },
    "sparkPass": {
      "model": "spark-small",
      "inference": { "topTags": ["string"], "confidence": 0.0 },
      "selectedBySpark": false,
      "why": "rule_high_confidence"
    },
    "finalSelection": {
      "mouth": "enum:mouth",
      "eye": "enum:eye",
      "brow": "enum:brow",
      "faceColor": "enum:face_color",
      "bodyGesture": "enum:body_gesture",
      "voiceStyle": "enum:voice_style"
    }
  },
  "layerCandidates": {
    "mouth": [{ "layerId": "string", "score": 0.0, "reason": "string" }],
    "eye": [{ "layerId": "string", "score": 0.0, "reason": "string" }],
    "brow": [{ "layerId": "string", "score": 0.0, "reason": "string" }],
    "faceColor": [{ "layerId": "string", "score": 0.0, "reason": "string" }],
    "bodyGesture": [{ "layerId": "string", "score": 0.0, "reason": "string" }],
    "voiceStyle": [{ "layerId": "string", "score": 0.0, "reason": "string" }]
  },
  "constraints": {
    "compatibility": [
      { "slotA": "mouth", "slotB": "eye", "status": "ok", "note": "string" }
    ]
  },
  "safety": {
    "ecchiHandling": {
      "detected": true,
      "mappedTo": ["shy", "flirty", "teasing"],
      "explicitBlocked": true,
      "allowedSurface": ["shy", "flirty", "teasing"],
      "forbiddenStyle": ["explicit", "sexual", "pervert"]
    },
    "contentFlags": ["sexuality_safe", "harassment_risk_low"],
    "riskLevel": "low"
  },
  "trainingPack": {
    "forLoraSmallModel": true,
    "labels": {
      "emotionPrimary": "string",
      "emotionSecondary": ["string"],
      "actionSignature": ["string"],
      "tone": "string"
    },
    "target": {
      "mouthEyeBrowComboKey": "sha256",
      "voiceAndGestureKey": "sha256"
    },
    "datasetMeta": {
      "split": "train",
      "source": "codex_progress_log",
      "quality": "raw"
    }
  },
  "audit": {
    "annotatorType": "auto",
    "reviewState": "pending",
    "notes": "string"
  }
}
```

## Emotion Categories

- neutral
- success
- trouble
- error
- surprise
- smile
- shy_flirty
- happy
- fun
- focused
- warning
- waiting

`shy_flirty` is the safe form of the requested light ecchi expression. Keep it shy, teasing, and non-explicit.

## Selector Strategy

Do not choose from 4368 pre-rendered files.
Choose fields independently, then validate the combination.

Selection dimensions:

- mouth
- eyes
- brows
- face color
- gesture
- voice style
- speech parameters

Each selection is saved, so future training can learn both the category and the layer choice.

## Recommended Values

Mouth:

- neutral
- small_smile
- wide_smile
- pucker
- open_small
- open_large
- surprise_open
- pout
- sad_tight
- whisper
- laugh

Eye:

- neutral
- sparkle
- squint
- half_open
- wide_open
- blink
- downcast
- upward
- anxious

Brow:

- neutral
- raised
- lowered
- furrow
- worried
- smug
- astonished
- teasing

Face color:

- normal
- blush_light
- blush_strong
- warm
- pale
- flushed
- cool_sick

Body gesture:

- idle
- head_tilt
- shoulder_shrug
- hand_wave
- point
- hands_on_hips
- bow_small
- lean_in
- retreat

Voice style:

- normal
- gentle
- bright
- serious
- playful
- shy
- teasing
- whisper
- calm
- energetic

## Rule To Spark Fallback

1. Apply deterministic rules first for explicit cue mapping and safety blockers.
2. If rule confidence is below threshold or conflicts are detected, run Spark analysis to propose candidates.
3. Merge with weighted rank, keeping rule safety constraints stronger than model suggestions.
4. Validate compatibility before emitting the final avatar state.
