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
  id: ModelId;
  name: string;
  contextLength: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  apiModelId?: string;
}

export const DEFAULT_MODEL_ID: ModelId = "MiniMax-M2.7";

const CTX_204K = 204_800;
const OUT_128K = 128_000;

export const SUPPORTED_MODELS: readonly ModelInfo[] = [
  { id: "MiniMax-M2.7", name: "MiniMax M2.7", contextLength: CTX_204K, maxInputTokens: 200_000, maxOutputTokens: OUT_128K },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 (High-Speed)", contextLength: CTX_204K, maxInputTokens: 200_000, maxOutputTokens: OUT_128K },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5", contextLength: CTX_204K, maxInputTokens: 200_000, maxOutputTokens: OUT_128K },
  { id: "MiniMax-M2.5-highspeed", name: "MiniMax M2.5 (High-Speed)", contextLength: CTX_204K, maxInputTokens: 200_000, maxOutputTokens: OUT_128K },
  { id: "MiniMax-M2.1", name: "MiniMax M2.1", contextLength: CTX_204K, maxInputTokens: 200_000, maxOutputTokens: OUT_128K },
  { id: "MiniMax-M2.1-highspeed", name: "MiniMax M2.1 (High-Speed)", contextLength: CTX_204K, maxInputTokens: 200_000, maxOutputTokens: OUT_128K },
  { id: "MiniMax-M2", name: "MiniMax M2", contextLength: CTX_204K, maxInputTokens: 200_000, maxOutputTokens: OUT_128K },
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
