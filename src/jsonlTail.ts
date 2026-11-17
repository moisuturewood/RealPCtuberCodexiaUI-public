import { open } from "node:fs/promises";

const readBlockBytes = 64 * 1024;

/** Read only enough of the tail to restore the requested non-empty JSONL lines. */
export async function readJsonlTail(filePath: string, maxLines: number): Promise<string[]> {
  if (!Number.isInteger(maxLines) || maxLines < 0) {
    throw new RangeError("maxLines must be a non-negative integer.");
  }
  if (maxLines === 0) {
    return [];
  }
  const file = await open(filePath, "r");
  try {
    let offset = (await file.stat()).size;
    const chunks: Buffer[] = [];
    let completeLines = 0;
    let hasContent = false;
    while (offset > 0 && completeLines < maxLines) {
      const size = Math.min(readBlockBytes, offset);
      offset -= size;
      const buffer = Buffer.allocUnsafe(size);
      let totalRead = 0;
      while (totalRead < size) {
        const { bytesRead } = await file.read(buffer, totalRead, size - totalRead, offset + totalRead);
        if (bytesRead === 0) {
          break;
        }
        totalRead += bytesRead;
      }
      const chunk = buffer.subarray(0, totalRead);
      chunks.push(chunk);
      // Count from the end so blank lines and UTF-8 characters crossing blocks
      // do not require decoding or copying the whole accumulated tail each time.
      for (let index = chunk.length - 1; index >= 0; index -= 1) {
        const byte = chunk[index];
        if (byte === 10) {
          if (hasContent) {
            completeLines += 1;
          }
          hasContent = false;
          if (completeLines >= maxLines) {
            break;
          }
        } else if (byte !== 13) {
          hasContent = true;
        }
      }
    }
    return Buffer.concat(chunks.reverse()).toString("utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } finally {
    await file.close();
  }
}
