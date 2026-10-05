import type { ReasoningChoices } from "../modelsDev";

export interface MiniMaxReasoningDetail {
  text: string;
  id?: string;
  type?: string;
  format?: string;
  index?: number;
  [key: string]: unknown;
}

export interface MiniMaxToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  index?: number;
}

export type MiniMaxChatContent = string | readonly MiniMaxUserContentPart[];

export type MiniMaxUserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface MiniMaxSystemMessage {
  role: "system";
  content: string;
  name?: string;
}

export interface MiniMaxUserMessage {
  role: "user";
  content: MiniMaxChatContent;
  name?: string;
}

export interface MiniMaxAssistantMessage {
  role: "assistant";
  content: string;
  name?: string;
  tool_calls?: MiniMaxToolCall[];
  reasoning_details?: MiniMaxReasoningDetail[];
}

export interface MiniMaxToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type MiniMaxMessage =
  | MiniMaxSystemMessage
  | MiniMaxUserMessage
  | MiniMaxAssistantMessage
  | MiniMaxToolMessage;

export interface MiniMaxToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export const DEFAULT_API_BASE_URL = "https://api.minimax.io/v1";

/** One entry from the provider's live GET {baseUrl}/models. Only the id is
 * guaranteed; limit / modality fields are picked up when the provider sends them. */
export interface LiveModelEntry {
  id: string;
  name?: string;
  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
}

/** Live-only catalog entry: limits resolved from the provider's own /models
 * fields first, else models.dev. `choices` holds the live reasoning controls
 * (undefined when the model exposes none). */
export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  imageInput: boolean;
  toolCall: boolean;
  choices?: ReasoningChoices;
}

/** Ids matching this pattern are never chat models (TTS / music / video / etc.)
 * and must not land in the chat model picker. */
export const NON_CHAT_MODEL_PATTERN =
  /embed|rerank|speech|video|music|tts|voice|image|whisper|moderation/i;

export function isChatModelId(id: string): boolean {
  return !NON_CHAT_MODEL_PATTERN.test(id);
}

export function humanizeModelId(id: string): string {
  const parts = id.split(/[-_]+/).filter((part) => part.length > 0);
  const words = parts.map((part) => {
    if (part.toLowerCase() === "minimax") {
      return "MiniMax";
    }
    if (/^[a-z]*\d[\w.]*$/i.test(part)) {
      return part.charAt(0).toUpperCase() + part.slice(1);
    }
    if (/^v?\d+(\.\d+)*$/i.test(part)) {
      return part.toUpperCase().startsWith("V") ? part.toUpperCase() : part;
    }
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  });
  return words.join(" ");
}

interface ModelsApiShape {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    context_window?: unknown;
    max_output_tokens?: unknown;
    input_modalities?: unknown;
  }>;
}

function readPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/** GET {baseUrl}/models with a Bearer key; returns chat-model entries only.
 * Throws on network/HTTP errors so the caller can keep the last good list. */
export async function fetchLiveModelCatalog(
  baseUrl: string,
  apiKey: string,
): Promise<LiveModelEntry[]> {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
  const fetchFn = globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("fetch is not available in this runtime");
  }
  const response = await fetchFn(`${normalizedBase}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`GET /models failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as ModelsApiShape;
  if (!body || !Array.isArray(body.data)) {
    throw new Error("GET /models returned an unexpected shape (missing data[])");
  }
  const entries: LiveModelEntry[] = [];
  for (const item of body.data) {
    if (!item || typeof item.id !== "string" || item.id.length === 0) {
      continue;
    }
    if (!isChatModelId(item.id)) {
      continue;
    }
    const entry: LiveModelEntry = { id: item.id };
    if (typeof item.name === "string" && item.name.length > 0) {
      entry.name = item.name;
    }
    const contextWindow = readPositiveInt(item.context_window);
    if (contextWindow !== undefined) {
      entry.context_window = contextWindow;
    }
    const maxOutput = readPositiveInt(item.max_output_tokens);
    if (maxOutput !== undefined) {
      entry.max_output_tokens = maxOutput;
    }
    if (Array.isArray(item.input_modalities)) {
      const modalities = item.input_modalities.filter(
        (modality): modality is string => typeof modality === "string",
      );
      if (modalities.length > 0) {
        entry.input_modalities = modalities;
      }
    }
    entries.push(entry);
  }
  return entries;
}
