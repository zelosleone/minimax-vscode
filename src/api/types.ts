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

export const MODEL_IDS = [
  "MiniMax-M3",
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
  "MiniMax-M2.1",
  "MiniMax-M2.1-highspeed",
  "MiniMax-M2",
] as const;

export type ModelId = (typeof MODEL_IDS)[number];

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  apiModelId?: string;
  imageInput?: boolean;
}

export const DEFAULT_MODEL_ID: ModelId = "MiniMax-M3";

const CTX_1M = 1_000_000;
const CTX_204K = 204_800;
const OUT_131K = 131_072;
const OUT_128K = 128_000;

export const DEFAULT_API_BASE_URL = "https://api.minimax.io/v1";

export const SUPPORTED_MODELS: readonly ModelInfo[] = [
  { id: "MiniMax-M3", name: "MiniMax M3", contextLength: CTX_1M, maxInputTokens: 1_000_000, maxOutputTokens: OUT_131K, imageInput: true },
  { id: "MiniMax-M2.7", name: "MiniMax M2.7", contextLength: CTX_204K, maxInputTokens: 200_000, maxOutputTokens: OUT_131K },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 (High-Speed)", contextLength: CTX_204K, maxInputTokens: 200_000, maxOutputTokens: OUT_131K },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5", contextLength: CTX_204K, maxInputTokens: 196_000, maxOutputTokens: OUT_128K },
  { id: "MiniMax-M2.5-highspeed", name: "MiniMax M2.5 (High-Speed)", contextLength: CTX_204K, maxInputTokens: 196_000, maxOutputTokens: OUT_128K },
  { id: "MiniMax-M2.1", name: "MiniMax M2.1", contextLength: CTX_204K, maxInputTokens: 196_000, maxOutputTokens: OUT_128K },
  { id: "MiniMax-M2.1-highspeed", name: "MiniMax M2.1 (High-Speed)", contextLength: CTX_204K, maxInputTokens: 196_000, maxOutputTokens: OUT_128K },
  { id: "MiniMax-M2", name: "MiniMax M2", contextLength: CTX_204K, maxInputTokens: 192_000, maxOutputTokens: OUT_128K },
];

const MODEL_BY_ID: Readonly<Record<ModelId, ModelInfo>> = Object.fromEntries(
  SUPPORTED_MODELS.map((model) => [model.id, model]),
) as Record<ModelId, ModelInfo>;

export function resolveModelIdForApi(id: string): string {
  const info = getModelById(id);
  if (!info) {
    return id;
  }
  return info.apiModelId ?? info.id;
}

export function getModelById(id: ModelId): ModelInfo;
export function getModelById(id: string): ModelInfo | undefined;
export function getModelById(id: string): ModelInfo | undefined {
  if (Object.prototype.hasOwnProperty.call(MODEL_BY_ID, id)) {
    return MODEL_BY_ID[id as ModelId];
  }
  return undefined;
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

const FALLBACK_CONTEXT_LENGTH = 204_800;
const FALLBACK_MAX_INPUT_TOKENS = 192_000;
const FALLBACK_MAX_OUTPUT_TOKENS = 128_000;

/** Resolve a live model id to a ModelInfo: known hit returns the enriched
 * entry, otherwise infer sensible chat defaults. */
export function resolveLiveModel(id: string): ModelInfo {
  const known = getModelById(id);
  if (known) {
    return known;
  }
  return {
    id,
    name: humanizeModelId(id),
    contextLength: FALLBACK_CONTEXT_LENGTH,
    maxInputTokens: FALLBACK_MAX_INPUT_TOKENS,
    maxOutputTokens: FALLBACK_MAX_OUTPUT_TOKENS,
    imageInput: /m3/i.test(id),
  };
}

/** Merge live ids with the known table: live order first, then any known
 * models the API did not report (so a sparse /models response never hides
 * a known chat model). */
export function mergeModelCatalog(liveIds: readonly string[]): ModelInfo[] {
  const seen = new Set<string>();
  const merged: ModelInfo[] = [];
  for (const id of liveIds) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push(resolveLiveModel(id));
  }
  for (const known of SUPPORTED_MODELS) {
    if (!seen.has(known.id)) {
      seen.add(known.id);
      merged.push(known);
    }
  }
  return merged;
}

interface ModelsApiShape {
  data?: Array<{ id?: unknown }>;
}

/** GET {baseUrl}/models with a Bearer key; returns chat-model ids only.
 * Throws on network/HTTP errors so the caller can keep the last good list. */
export async function fetchLiveModelCatalog(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
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
  const ids: string[] = [];
  for (const entry of body.data) {
    if (entry && typeof entry.id === "string" && isChatModelId(entry.id)) {
      ids.push(entry.id);
    }
  }
  return ids;
}
