const sentenceSegmenter = new Intl.Segmenter("ja", { granularity: "sentence" });

export function splitSpeechSentences(input: string): string[] {
  const text = input.trim();
  if (!text) {
    return [];
  }

  const sentences = [...sentenceSegmenter.segment(text)]
    .map(({ segment }) => segment.trim())
    .filter(Boolean);
  return sentences.length > 0 ? sentences : [text];
}
