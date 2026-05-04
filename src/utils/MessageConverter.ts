import * as vscode from "vscode";
import type {
  MiniMaxAssistantMessage,
  MiniMaxMessage,
  MiniMaxReasoningDetail,
  MiniMaxToolCall,
  MiniMaxToolMessage,
  MiniMaxChatContent,
} from "../api/types";
import { isThinkingPart, toReasoningDetail } from "./ThinkingPartDetector";
import { readNonEmptyString } from "./ThinkingHelper";

export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): MiniMaxMessage[] {
  const converted: MiniMaxMessage[] = [];
  for (const message of messages) {
    converted.push(...toMiniMaxMessages(message));
  }
  return converted;
}

function toMiniMaxMessages(message: vscode.LanguageModelChatRequestMessage): MiniMaxMessage[] {
  const parts = getMessageParts(message);
  const name = readNonEmptyString(message.name);

  if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
    return [toMiniMaxAssistantMessage(parts, name)];
  }

  if (message.role === vscode.LanguageModelChatMessageRole.User) {
    return toMiniMaxUserAndToolMessages(parts, name);
  }

  return [
    {
      role: "system",
      content: concatTextParts(parts),
      ...(name ? { name } : {}),
    },
  ];
}

function getMessageParts(message: vscode.LanguageModelChatRequestMessage): readonly unknown[] {
  if (Array.isArray(message.content)) {
    return message.content as readonly unknown[];
  }

  if (typeof message.content === "string") {
    return [new vscode.LanguageModelTextPart(message.content)];
  }

  return [];
}

function toMiniMaxAssistantMessage(
  parts: readonly unknown[],
  name?: string,
): MiniMaxAssistantMessage {
  const content = concatTextParts(parts);
  const toolCalls: MiniMaxToolCall[] = [];
  const reasoningDetails: MiniMaxReasoningDetail[] = [];

  for (const part of parts) {
    if (part instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push({
        id: part.callId,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        },
      });
      continue;
    }

    const detail = toReasoningDetail(part, reasoningDetails.length);
    if (detail) {
      reasoningDetails.push(detail);
    }
  }

  return {
    role: "assistant",
    content,
    ...(name ? { name } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
  };
}

function toMiniMaxUserAndToolMessages(
  parts: readonly unknown[],
  name?: string,
): MiniMaxMessage[] {
  const userContent = buildUserMessageContent(parts);
  const toolMessages: MiniMaxToolMessage[] = [];

  for (const part of parts) {
    if (part instanceof vscode.LanguageModelToolResultPart) {
      toolMessages.push({
        role: "tool",
        tool_call_id: part.callId,
        content: concatToolResultContent(part.content),
      });
    }
  }

  const hasTextOrMedia =
    typeof userContent === "string"
      ? userContent.trim().length > 0
      : userContent.length > 0;
  const messages: MiniMaxMessage[] = [];
  if (hasTextOrMedia || toolMessages.length === 0) {
    messages.push({
      role: "user",
      content: userContent,
      ...(name ? { name } : {}),
    });
  }
  messages.push(...toolMessages);
  return messages;
}

function buildUserMessageContent(parts: readonly unknown[]): MiniMaxChatContent {
  return concatTextParts(parts);
}

function concatTextParts(parts: readonly unknown[]): string {
  let text = "";
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
  }
  return text;
}

function concatToolResultContent(parts: readonly unknown[]): string {
  let text = "";
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    } else if (part instanceof vscode.LanguageModelDataPart) {
      text += `[data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}]`;
    } else if (
      part &&
      typeof part === "object" &&
      "value" in part &&
      typeof (part as { value?: unknown }).value === "string"
    ) {
      text += (part as { value: string }).value;
    } else {
      text += safeJson(part);
    }
  }

  const normalized = text.trim();
  return normalized.length > 0 ? normalized : "{}";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
