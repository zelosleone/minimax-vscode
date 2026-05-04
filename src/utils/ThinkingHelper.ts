import * as vscode from "vscode";

export interface ReasoningUpdate {
  text: string;
  id?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export type ThinkingPartCtor = new (
  thinking: string,
  metadata?: Readonly<Record<string, unknown>>,
) => unknown;

export function getThinkingPartCtor(): ThinkingPartCtor | undefined {
  const vscodeWithThinking = vscode as unknown as {
    LanguageModelThinkingPart?: ThinkingPartCtor;
  };
  return typeof vscodeWithThinking.LanguageModelThinkingPart === "function"
    ? vscodeWithThinking.LanguageModelThinkingPart
    : undefined;
}

export function getLatestReasoningUpdate(choice: {
  delta?: unknown;
}): ReasoningUpdate | undefined {
  const delta = choice.delta as { reasoning_details?: unknown } | undefined;
  const reasoningDetails = delta?.reasoning_details;
  if (!Array.isArray(reasoningDetails)) {
    return undefined;
  }

  let latest: ReasoningUpdate | undefined;
  for (const detail of reasoningDetails) {
    if (!detail || typeof detail !== "object") {
      continue;
    }

    const candidate = detail as Record<string, unknown>;
    if (typeof candidate.text !== "string") {
      continue;
    }

    const id =
      readNonEmptyString(candidate.id) ??
      readNonEmptyString(candidate.reasoning_id) ??
      readNonEmptyString(candidate.thinking_id);

    const metadata =
      candidate.metadata &&
      typeof candidate.metadata === "object" &&
      !Array.isArray(candidate.metadata)
        ? (candidate.metadata as Readonly<Record<string, unknown>>)
        : undefined;

    latest = {
      text: candidate.text,
      id,
      metadata,
    };
  }
  return latest;
}

export function reportReasoning(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  thinkingPartCtor: ThinkingPartCtor | undefined,
  text: string,
  reasoning: ReasoningUpdate,
): void {
  if (!thinkingPartCtor) {
    progress.report(new vscode.LanguageModelTextPart(`[thinking]${text}[/thinking]`));
    return;
  }

  const thinkingMetadata =
    reasoning.id || reasoning.metadata
      ? {
          ...(reasoning.metadata ?? {}),
          ...(reasoning.id ? { id: reasoning.id } : {}),
        }
      : undefined;
  const thinkingPart = new thinkingPartCtor(text, thinkingMetadata);
  (progress as vscode.Progress<vscode.LanguageModelResponsePart | unknown>).report(
    thinkingPart as vscode.LanguageModelResponsePart,
  );
}

export function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";
const OPEN_LEN = OPEN_TAG.length;
const CLOSE_LEN = CLOSE_TAG.length;

export class InlineThinkingParser {
  private inside = false;
  private carry = "";

  feed(content: string): { cleaned: string; thinking: string } {
    let cleaned = "";
    let thinking = "";

    let remaining = this.carry + content;
    this.carry = "";

    while (remaining.length > 0) {
      if (this.inside) {
        const ci = remaining.indexOf(CLOSE_TAG);
        if (ci !== -1) {
          thinking += remaining.slice(0, ci);
          remaining = remaining.slice(ci + CLOSE_LEN);
          this.inside = false;
          continue;
        }

        const keep = getTagPrefixSuffixLength(remaining, CLOSE_TAG);
        if (keep > 0) {
          thinking += remaining.slice(0, remaining.length - keep);
          this.carry = remaining.slice(remaining.length - keep);
        } else {
          thinking += remaining;
        }
        return { cleaned, thinking };
      }

      const oi = remaining.indexOf(OPEN_TAG);
      if (oi !== -1) {
        cleaned += remaining.slice(0, oi);
        remaining = remaining.slice(oi + OPEN_LEN);
        this.inside = true;
        continue;
      }

      const keep = getTagPrefixSuffixLength(remaining, OPEN_TAG);
      if (keep > 0) {
        cleaned += remaining.slice(0, remaining.length - keep);
        this.carry = remaining.slice(remaining.length - keep);
      } else {
        cleaned += remaining;
      }
      return { cleaned, thinking };
    }

    return { cleaned, thinking };
  }

  reset(): void {
    this.inside = false;
    this.carry = "";
  }
}

function getTagPrefixSuffixLength(value: string, tag: string): number {
  const maxLength = Math.min(value.length, tag.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (value.endsWith(tag.slice(0, length))) {
      return length;
    }
  }
  return 0;
}
