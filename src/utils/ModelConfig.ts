import * as vscode from "vscode";
import {
  SUPPORTED_MODELS,
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

export function modelsWithApiKey(
  allModels: readonly ModelInfo[] = SUPPORTED_MODELS,
): vscode.LanguageModelChatInformation[] {
  const visibleModels = getVisibleModels(allModels);
  return visibleModels.map(
    (model) =>
      ({
        id: model.id,
        name: model.name,
        detail: "Token Plan",
        tooltip: `${model.name} -- in ${model.maxInputTokens.toLocaleString()} / out ${model.maxOutputTokens.toLocaleString()} max tokens (context up to ${model.contextLength.toLocaleString()})`,
        family: "minimax",
        version: getModelVersion(model.id),
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        isUserSelectable: true,
        capabilities: {
          toolCalling: true,
          imageInput: model.imageInput ?? model.id === "MiniMax-M3",
        },
      }) as vscode.LanguageModelChatInformation,
  );
}

function getModelVersion(modelId: string): string {
  switch (modelId) {
    case "MiniMax-M3":
      return "3";
    case "MiniMax-M2.7":
      return "2.7";
    case "MiniMax-M2.7-highspeed":
      return "2.7-highspeed";
    case "MiniMax-M2.5":
      return "2.5";
    case "MiniMax-M2.5-highspeed":
      return "2.5-highspeed";
    case "MiniMax-M2.1":
      return "2.1";
    case "MiniMax-M2.1-highspeed":
      return "2.1-highspeed";
    case "MiniMax-M2":
      return "2";
    default:
      return modelId.replace(/^MiniMax-/i, "") || modelId;
  }
}

export function getVisibleModels(
  allModels: readonly ModelInfo[] = SUPPORTED_MODELS,
): readonly ModelInfo[] {
  const live = allModels.length > 0 ? allModels : SUPPORTED_MODELS;
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = config.get<unknown>(VISIBLE_MODELS_KEY);
  if (!Array.isArray(raw)) {
    return [...live];
  }

  // NB: the package.json enum for minimax.visibleModels is suggestions-only,
  // so live ids absent from it must still be selectable here.
  const configuredIds = new Set(
    raw.filter((value): value is string => typeof value === "string"),
  );
  const visibleModels = live.filter((model) => configuredIds.has(model.id));
  return visibleModels.length > 0 ? visibleModels : [...live];
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
