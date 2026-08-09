import * as vscode from "vscode";
import type {
  MiniMaxAssistantMessage,
  MiniMaxMessage,
  MiniMaxReasoningDetail,
  MiniMaxToolCall,
  MiniMaxToolMessage,
  MiniMaxChatContent,
  MiniMaxUserContentPart,
} from "../api/types";
import { isThinkingPart, toReasoningDetail } from "./ThinkingPartDetector";
import { readNonEmptyString } from "./ThinkingHelper";

export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): MiniMaxMessage[] {
  // Build a lookup of every tool call's name + parsed arguments so that, when
  // we convert a tool result, we can prepend the actual file path the tool
  // acted on. Without this, a file whose first line is `# old_name.py`
  // confuses the model into thinking it read `old_name.py` (issue #20).
  const toolCallsByCallId = buildToolCallIndex(messages);
  const converted: MiniMaxMessage[] = [];
  for (const message of messages) {
    converted.push(...toMiniMaxMessages(message, toolCallsByCallId));
  }
  return converted;
}

/**
 * Walks the request once and records every `LanguageModelToolCallPart` keyed
 * by its `callId`, so tool results can later resolve back to the tool name
 * and arguments.
 */
function buildToolCallIndex(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): Map<string, ToolCallInfo> {
  const index = new Map<string, ToolCallInfo>();
  for (const message of messages) {
    const parts = getMessageParts(message);
    for (const part of parts) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        index.set(part.callId, {
          name: part.name,
          input: coerceToolCallInput(part.input),
        });
      }
    }
  }
  return index;
}

interface ToolCallInfo {
  name: string;
  input: Record<string, unknown>;
}

function coerceToolCallInput(input: object | undefined): Record<string, unknown> {
  if (!input) {
    return {};
  }
  if (Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function toMiniMaxMessages(
  message: vscode.LanguageModelChatRequestMessage,
  toolCallsByCallId: Map<string, ToolCallInfo>,
): MiniMaxMessage[] {
  const parts = getMessageParts(message);
  const name = readNonEmptyString(message.name);

  if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
    return [toMiniMaxAssistantMessage(parts, name)];
  }

  if (message.role === vscode.LanguageModelChatMessageRole.User) {
    return toMiniMaxUserAndToolMessages(parts, name, toolCallsByCallId);
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
  name: string | undefined,
  toolCallsByCallId: Map<string, ToolCallInfo>,
): MiniMaxMessage[] {
  const userContent = buildUserMessageContent(parts);
  const toolMessages: MiniMaxToolMessage[] = [];

  for (const part of parts) {
    if (part instanceof vscode.LanguageModelToolResultPart) {
      const content = concatToolResultContent(part.content);
      toolMessages.push({
        role: "tool",
        tool_call_id: part.callId,
        content: annotateToolResultFilePath(
          part.callId,
          content,
          toolCallsByCallId,
        ),
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
  const hasMedia = parts.some((part) => part instanceof vscode.LanguageModelDataPart);

  if (!hasMedia) {
    return concatTextParts(parts);
  }

  const contentParts: MiniMaxUserContentPart[] = [];
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      const text = part.value;
      if (text.length > 0) {
        contentParts.push({ type: "text", text });
      }
    } else if (part instanceof vscode.LanguageModelDataPart) {
      if (isImageMimeType(part.mimeType)) {
        const base64 = Buffer.from(part.data).toString("base64");
        const dataUrl = `data:${part.mimeType};base64,${base64}`;
        contentParts.push({
          type: "image_url",
          image_url: { url: dataUrl },
        });
      }
    }
  }

  return contentParts.length > 0 ? contentParts : "";
}

function isImageMimeType(mimeType: string): boolean {
  return [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ].includes(mimeType);
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
      if (part.mimeType !== "cache_control") {
        text += `[data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}]`;
      }
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

/**
 * Tool names that fetch file contents. VS Code's own `vscode_get_file_text`
 * tool uses a fixed `filePath` argument; third-party tools use a variety of
 * names. We match on a small allowlist and extract the path from whatever
 * field the tool uses.
 */
const FILE_READ_TOOL_NAMES = new Set([
  "read_file",
  "get_file",
  "view_file",
  "open_file",
  "fetch_file",
  "read_file_with_line_range",
  "vscode_get_file_text",
]);

function annotateToolResultFilePath(
  callId: string,
  content: string,
  toolCallsByCallId: Map<string, ToolCallInfo>,
): string {
  if (!content || content === "{}") {
    return content;
  }
  const call = toolCallsByCallId.get(callId);
  if (!call || !FILE_READ_TOOL_NAMES.has(call.name)) {
    return content;
  }

  const filePath = extractFilePath(call.input);
  if (!filePath) {
    return content;
  }

  return `[File: ${filePath}]\n${content}`;
}

/**
 * Looks for a path-looking string in the tool call's input arguments. Different
 * tools name the field differently (`filePath`, `path`, `uri`, `file`,
 * `relative_path`), and `uri` may arrive as a `vscode.Uri` instance, a string,
 * or an object with a `path`/`fsPath` property.
 */
function extractFilePath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) {
    return undefined;
  }

  const candidates = [
    "filePath",
    "file_path",
    "path",
    "uri",
    "file",
    "relativePath",
    "relative_path",
    "filename",
  ];

  for (const key of candidates) {
    const raw = input[key];
    const resolved = normalizePathLike(raw);
    if (resolved) {
      return resolved;
    }
  }

  return undefined;
}

function normalizePathLike(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const obj = value as { fsPath?: unknown; path?: unknown};
  return (
    normalizePathLike(obj.fsPath) ??
    normalizePathLike(obj.path)
  );
}
