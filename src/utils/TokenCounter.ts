import * as vscode from "vscode";

const CHARS_PER_TOKEN_KEY = "minimax.charsPerToken";

export class TokenCounter {
  private charsPerToken = 4;

  constructor(private readonly globalState?: vscode.Memento) {
    if (globalState) {
      const saved = globalState.get<number>(CHARS_PER_TOKEN_KEY);
      if (typeof saved === "number" && Number.isFinite(saved) && saved >= 1 && saved <= 12) {
        this.charsPerToken = saved;
      }
    }
  }

  estimateTokens(text: string): number {
    return Math.max(1, Math.round(text.length / this.charsPerToken));
  }

  /** Tokens for an already provider-converted payload, with image data removed. */
  estimatePayload(value: unknown): number {
    return Math.max(1, Math.round(this.payloadChars(value) / this.charsPerToken));
  }

  /** JSON length of a payload with image data (data URLs / base64) removed. */
  payloadChars(value: unknown): number {
    let json: string;
    try {
      json = JSON.stringify(value) ?? "";
    } catch {
      json = String(value);
    }
    return json.replace(/data:[^;"']+;base64,[A-Za-z0-9+/=\r\n]+/g, "data:stripped").length;
  }

  /** Recalibrate from a usage chunk: ratio of request chars to prompt tokens. */
  calibrate(requestChars: number, promptTokens: number): void {
    if (
      !Number.isFinite(requestChars) ||
      !Number.isFinite(promptTokens) ||
      requestChars <= 0 ||
      promptTokens <= 0
    ) {
      return;
    }
    const ratio = Math.min(12, Math.max(1, requestChars / promptTokens));
    this.charsPerToken = 0.7 * this.charsPerToken + 0.3 * ratio;
    void this.globalState?.update(CHARS_PER_TOKEN_KEY, this.charsPerToken);
  }
}
