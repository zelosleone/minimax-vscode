import * as vscode from "vscode";
import { reasoningSchema, tokenLimits } from "../modelsDev";
import type { ModelInfo } from "../api/types";

export const CONFIG_SECTION = "minimax";
export const VISIBLE_MODELS_KEY = "visibleModels";
export const API_BASE_URL_KEY = "apiBaseUrl";
export const DEFAULT_TEMPERATURE = 1;

export function getApiBaseUrl(): string | undefined {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const url = config.get<string>(API_BASE_URL_KEY);
  if (typeof url === "string" && url.trim().length > 0) {
    return url.trim();
  }
  return undefined;
}

export function modelsWithApiKey(
  allModels: readonly ModelInfo[],
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
        version: model.id,
        ...tokenLimits(model.contextLength, model.maxOutputTokens),
        isBYOK: true,
        capabilities: {
          toolCalling: model.toolCall,
          imageInput: model.imageInput,
        },
        ...(model.choices ? { configurationSchema: reasoningSchema(model.choices) } : {}),
      }) as unknown as vscode.LanguageModelChatInformation,
  );
}

export function getVisibleModels(allModels: readonly ModelInfo[]): readonly ModelInfo[] {
  if (allModels.length === 0) {
    return [];
  }
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const raw = config.get<unknown>(VISIBLE_MODELS_KEY);
  if (!Array.isArray(raw)) {
    return [...allModels];
  }

  // NB: minimax.visibleModels holds plain live ids (no enum); an empty list
  // means "show every live model".
  const configuredIds = new Set(
    raw.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  if (configuredIds.size === 0) {
    return [...allModels];
  }
  const visibleModels = allModels.filter((model) => configuredIds.has(model.id));
  return visibleModels.length > 0 ? visibleModels : [...allModels];
}

/** max_tokens is sent ONLY when Copilot passes options.modelOptions.maxTokens
 * (capped by the live maxOutputTokens); otherwise it is omitted, because
 * MiniMax counts thinking tokens toward max_tokens and a low default would
 * truncate high-effort answers with empty content. */
export function resolveMaxTokens(
  options: vscode.ProvideLanguageModelChatResponseOptions,
  model: ModelInfo,
): number | undefined {
  const value = options.modelOptions?.maxTokens;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return Math.min(value, model.maxOutputTokens);
  }
  return undefined;
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
