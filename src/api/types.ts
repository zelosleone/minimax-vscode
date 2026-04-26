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

export interface MiniMaxSystemMessage {
  role: "system";
  content: string;
}

export interface MiniMaxUserMessage {
  role: "user";
  content: string;
}

export interface MiniMaxAssistantMessage {
  role: "assistant";
  content: string;
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
  "MiniMax-M2",
  "MiniMax-M2-her",
] as const;

export type ModelId = (typeof MODEL_IDS)[number];

export interface ModelInfo {
  id: ModelId;
  name: string;
  contextLength: number;
}

export const DEFAULT_MODEL_ID: ModelId = "MiniMax-M2.7";

export const SUPPORTED_MODELS: readonly ModelInfo[] = [
  { id: "MiniMax-M2.7", name: "MiniMax M2.7", contextLength: 204800 },
  { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 (High-Speed)", contextLength: 204800 },
  { id: "MiniMax-M2.5", name: "MiniMax M2.5", contextLength: 204800 },
  { id: "MiniMax-M2.5-highspeed", name: "MiniMax M2.5 (High-Speed)", contextLength: 204800 },
  { id: "MiniMax-M2.1", name: "MiniMax M2.1", contextLength: 204800 },
  { id: "MiniMax-M2", name: "MiniMax M2", contextLength: 204800 },
  { id: "MiniMax-M2-her", name: "MiniMax M2-her (Role-play)", contextLength: 204800 },
];

const MODEL_BY_ID: Readonly<Record<ModelId, ModelInfo>> = Object.fromEntries(
  SUPPORTED_MODELS.map((model) => [model.id, model]),
) as Record<ModelId, ModelInfo>;

export function getModelById(id: ModelId): ModelInfo;
export function getModelById(id: string): ModelInfo | undefined;
export function getModelById(id: string): ModelInfo | undefined {
  return MODEL_BY_ID[id as ModelId];
}
