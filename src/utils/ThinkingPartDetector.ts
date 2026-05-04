import * as vscode from "vscode";
import type { MiniMaxReasoningDetail } from "../api/types";
import { readNonEmptyString } from "./ThinkingHelper";

export function isThinkingPart(
  value: unknown,
): value is { value?: string | string[]; thinking?: string; id?: unknown; format?: unknown; metadata?: unknown } {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (value instanceof vscode.LanguageModelTextPart) {
    return false;
  }
  if (value instanceof vscode.LanguageModelToolCallPart) {
    return false;
  }
  if (value instanceof vscode.LanguageModelToolResultPart) {
    return false;
  }
  if (value instanceof vscode.LanguageModelDataPart) {
    return false;
  }

  const candidate = value as { value?: unknown; thinking?: unknown };
  const hasOldShape = typeof candidate.value === "string" || Array.isArray(candidate.value);
  const hasNewShape = typeof candidate.thinking === "string";

  if (!hasOldShape && !hasNewShape) {
    return false;
  }

  if (Array.isArray(candidate.value)) {
    return candidate.value.every((item) => typeof item === "string");
  }

  return true;
}

function extractThinkingText(part: { value?: string | string[]; thinking?: string }): string {
  if (typeof part.thinking === "string" && part.thinking.length > 0) {
    return part.thinking;
  }
  const value = part.value;
  if (Array.isArray(value)) {
    return value.join("");
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

export function toReasoningDetail(
  part: unknown,
  index: number,
): MiniMaxReasoningDetail | undefined {
  if (!isThinkingPart(part)) {
    return undefined;
  }

  const text = extractThinkingText(part);
  if (!text || text.trim().length === 0) {
    return undefined;
  }

  const detail: MiniMaxReasoningDetail = {
    type: "reasoning.text",
    index,
    text,
  };

  const id = readNonEmptyString(part.id);
  if (id) {
    detail.id = id;
  }

  const format = readNonEmptyString(part.format);
  if (format) {
    detail.format = format;
  }

  const metadata = part.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    Object.assign(detail, metadata as Record<string, unknown>);
  }

  return detail;
}
