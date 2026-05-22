/**
 * Streaming narration extractor.
 *
 * Why this exists:
 * - The GM responds in a JSON envelope where `narration` is one of several fields.
 * - Streaming JSON tokens are useless to a user — they want prose appearing live.
 * - We can't wait for the full JSON to parse before showing anything (that's the
 *   20-45s wait we're trying to eliminate).
 *
 * This is a small character-by-character state machine that watches a growing
 * buffer for `"narration":"..."` and emits each character of the inner string
 * as soon as it's seen, handling escape sequences correctly.
 *
 * Limitations:
 * - Assumes `narration` appears as a top-level string field — true for our schema.
 * - If the model emits `narration` as a different case or with extra whitespace
 *   that we don't handle, the extractor stays in "scanning" mode and emits nothing,
 *   which is safe (the full JSON parse at the end still succeeds).
 */
export type NarrationExtractor = {
  /** Push more text from the LLM stream. Returns any new narration characters extracted. */
  feed: (chunk: string) => string;
  /** Returns true once the closing quote of the narration string was seen. */
  isComplete: () => boolean;
};

type State =
  | "scan-for-key"     // looking for "narration"
  | "after-key"        // saw "narration", looking for ":"
  | "after-colon"      // saw ":", looking for opening quote
  | "in-string"        // inside the narration string, emit each char
  | "in-escape"        // last char was `\`, the next is escaped
  | "complete";        // closing quote seen

const NARRATION_KEY = "\"narration\"";

export const createNarrationExtractor = (): NarrationExtractor => {
  let state: State = "scan-for-key";
  let buffer = "";
  let bufferStart = 0; // index in original stream where buffer[0] sits

  const feed = (chunk: string): string => {
    buffer += chunk;
    let emitted = "";

    // We may need to walk multiple state transitions per chunk.
    while (true) {
      switch (state) {
        case "scan-for-key": {
          const keyIndex = buffer.indexOf(NARRATION_KEY, bufferStart);
          if (keyIndex === -1) {
            // Keep just enough tail to match a partial key on the next chunk.
            const keepFrom = Math.max(0, buffer.length - NARRATION_KEY.length);
            if (keepFrom > 0) {
              buffer = buffer.slice(keepFrom);
              bufferStart = 0;
            }
            return emitted;
          }
          bufferStart = keyIndex + NARRATION_KEY.length;
          state = "after-key";
          continue;
        }
        case "after-key": {
          while (bufferStart < buffer.length && /\s/.test(buffer[bufferStart])) bufferStart++;
          if (bufferStart >= buffer.length) return emitted;
          if (buffer[bufferStart] !== ":") {
            // Not actually our key — keep scanning past it.
            state = "scan-for-key";
            continue;
          }
          bufferStart++;
          state = "after-colon";
          continue;
        }
        case "after-colon": {
          while (bufferStart < buffer.length && /\s/.test(buffer[bufferStart])) bufferStart++;
          if (bufferStart >= buffer.length) return emitted;
          if (buffer[bufferStart] !== "\"") {
            // Value is null or some other non-string literal — give up cleanly.
            state = "complete";
            return emitted;
          }
          bufferStart++;
          state = "in-string";
          continue;
        }
        case "in-string": {
          while (bufferStart < buffer.length) {
            const ch = buffer[bufferStart];
            if (ch === "\\") {
              state = "in-escape";
              bufferStart++;
              break;
            }
            if (ch === "\"") {
              state = "complete";
              bufferStart++;
              return emitted;
            }
            emitted += ch;
            bufferStart++;
          }
          if (state === "in-string") return emitted;
          continue;
        }
        case "in-escape": {
          if (bufferStart >= buffer.length) return emitted;
          const ch = buffer[bufferStart];
          // JSON escape table; minimal — we only need the common ones.
          const map: Record<string, string> = { "\"": "\"", "\\": "\\", "/": "/", n: "\n", t: "\t", r: "\r" };
          if (map[ch] !== undefined) {
            emitted += map[ch];
            bufferStart++;
          } else if (ch === "u") {
            // Unicode escape \uXXXX — wait for 4 hex chars before emitting.
            if (bufferStart + 5 > buffer.length) return emitted;
            const codepoint = parseInt(buffer.slice(bufferStart + 1, bufferStart + 5), 16);
            if (!Number.isNaN(codepoint)) {
              emitted += String.fromCharCode(codepoint);
            }
            bufferStart += 5;
          } else {
            // Unknown escape — emit literally and keep going.
            emitted += ch;
            bufferStart++;
          }
          state = "in-string";
          continue;
        }
        case "complete":
          return emitted;
      }
    }
  };

  return {
    feed,
    isComplete: () => state === "complete",
  };
};
