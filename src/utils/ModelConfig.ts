import * as vscode from "vscode";
import {
  SUPPORTED_MODELS,
  getModelById,
  type ModelInfo,
} from "../api/types";

export const CONFIG_SECTION = "minimax";
export const VISIBLE_MODELS_KEY = "visibleModels";
export const API_BASE_URL_KEY = "apiBaseUrl";
export const DEFAULT_TEMPERATURE = 1;
export const DEFAULT_MAX_TOKENS = 8192;

export function getApiBaseUrl(): string | undefined {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const url = config.get<string>(API_BASE_URL_KEY);
  if (typeof url === "string" && url.trim().length > 0) {
    return url.trim();
  }
  return undefined;
}

export function modelsWithApiKey(): vscode.LanguageModelChatInformation[] {
  const visibleModels = getVisibleModels();
  return visibleModels.map(
    (model) =>
      ({
        id: model.id,
        name: model.name,
        detail: "Token Plan",
        tooltip: `${model.name} -- in ${model.maxInputTokens.toLocaleString()} / out ${model.maxOutputTokens.toLocaleString()} max tokens (context up to ${model.contextLength.toLocaleString()})`,
        family: model.id,
        version: "1.0",
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: {
          toolCalling: true,
          imageInput: false,
        },
      }) satisfies vscode.LanguageModelChatInformation,
  );
}

function getVisibleModels(): readonly ModelInfo[] {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = config.get<unknown>(VISIBLE_MODELS_KEY);
  if (!Array.isArray(raw)) {
    return SUPPORTED_MODELS;
  }

  const configuredIds = new Set(
    raw
      .filter((value): value is string => typeof value === "string")
      .filter((id) => getModelById(id) !== undefined),
  );
  const visibleModels = SUPPORTED_MODELS.filter((model) => configuredIds.has(model.id));
  return visibleModels.length > 0 ? visibleModels : SUPPORTED_MODELS;
}

export function resolveMaxTokens(
  options: vscode.ProvideLanguageModelChatResponseOptions,
  model: ModelInfo,
): number {
  const value = options.modelOptions?.maxTokens;
  const base =
    typeof value === "number" && Number.isInteger(value) && value > 0
      ? value
      : DEFAULT_MAX_TOKENS;
  return Math.min(base, model.maxOutputTokens);
}

export function resolveTemperature(
  options: vscode.ProvideLanguageModelChatResponseOptions,
): number {
  const value = options.modelOptions?.temperature;
  if (typeof value === "number" && value > 0 && value <= 1) {
    return value;
  }
  return DEFAULT_TEMPERATURE;
}

export function resolveTopP(
  options: vscode.ProvideLanguageModelChatResponseOptions,
): number | undefined {
  const optionsRecord = options.modelOptions as
    | { topP?: unknown; top_p?: unknown }
    | undefined;
  if (!optionsRecord) {
    return undefined;
  }
  const raw = optionsRecord.topP ?? optionsRecord.top_p;
  if (typeof raw === "number" && raw > 0 && raw <= 1) {
    return raw;
  }
  return undefined;
}
