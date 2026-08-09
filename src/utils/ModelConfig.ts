import * as vscode from "vscode";
import {
  SUPPORTED_MODELS,
  getModelById,
  type ModelId,
  type ModelInfo,
} from "../api/types";

export const CONFIG_SECTION = "minimax";
export const VISIBLE_MODELS_KEY = "visibleModels";
export const API_BASE_URL_KEY = "apiBaseUrl";
/**
 * Legacy boolean key retained for backward compatibility with the old
 * settings UI and existing user configs. The chat-model picker surfaces the
 * newer {@link THINKING_MODE_KEY} dropdown; this key is still honored when
 * present so prior installs don't silently change behavior.
 */
export const THINKING_ENABLED_KEY = "thinkingEnabled";
export const THINKING_MODE_KEY = "thinkingMode";
export const API_FORMAT_KEY = "apiFormat";
export const ANTHROPIC_BASE_URL_KEY = "anthropicBaseUrl";
export const DEFAULT_TEMPERATURE = 1;
export const DEFAULT_MAX_TOKENS = 8192;

export type ApiFormat = "openai-compat" | "anthropic-compat";

/**
 * Thinking control surfaced in the chat-model picker.
 *
 * - `off`      — never emit thinking blocks. On M3 this maps to
 *                `thinking: {"type":"disabled"}`. M2.x accepts the field but
 *                still thinks, so for those models `off` is effectively
 *                advisory (the docs say thinking cannot be disabled).
 * - `adaptive` — always-on thinking. Maps to `thinking: {"type":"adaptive"}`.
 * - `auto`     — let the API / model decide. For Anthropic-compat that means
 *                thinking OFF for M3 (the Anthropic endpoint default) and ON
 *                for M2.x (which can't be disabled anyway). For OpenAI-compat
 *                that means thinking ON for M3 (the OpenAI endpoint default)
 *                and ON for M2.x. Concretely: omit the `thinking` field on
 *                the wire so the endpoint's own default takes effect.
 */
export type ThinkingMode = "off" | "adaptive" | "auto";

const THINKING_MODES: readonly ThinkingMode[] = ["off", "adaptive", "auto"];

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === "string" && (THINKING_MODES as readonly string[]).includes(value);
}

/**
 * Returns the currently configured thinking mode. Falls back through the
 * legacy `thinkingEnabled` boolean so older user configs keep their previous
 * behavior. Default is `adaptive` (think on), which matches the historical
 * default where `thinkingEnabled` was undefined → true.
 */
export function getThinkingMode(): ThinkingMode {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const mode = config.get<unknown>(THINKING_MODE_KEY);
  if (isThinkingMode(mode)) {
    return mode;
  }
  // Legacy fallback: honor the old boolean if it was explicitly set.
  const legacy = config.get<unknown>(THINKING_ENABLED_KEY);
  if (typeof legacy === "boolean") {
    return legacy ? "adaptive" : "off";
  }
  return "adaptive";
}

export async function setThinkingMode(mode: ThinkingMode): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(THINKING_MODE_KEY, mode, vscode.ConfigurationTarget.Global);
  // Keep the legacy boolean in sync so anything still reading it stays
  // consistent (commands, status bar, persisted user setting).
  await config.update(
    THINKING_ENABLED_KEY,
    mode !== "off",
    vscode.ConfigurationTarget.Global,
  );
}

export function thinkingModeLabel(mode: ThinkingMode): string {
  switch (mode) {
    case "off":
      return "Off";
    case "adaptive":
      return "On (adaptive)";
    case "auto":
      return "Auto";
  }
}

export function thinkingModeDescription(mode: ThinkingMode): string {
  switch (mode) {
    case "off":
      return "Disable thinking for M3 (faster, no reasoning tokens). M2.x cannot disable thinking.";
    case "adaptive":
      return "Always-on thinking for M3 (`thinking: {\"type\":\"adaptive\"}`). M2.x always thinks.";
    case "auto":
      return "Use the endpoint default — Anthropic: off for M3, on for M2.x. OpenAI: on for M3, on for M2.x.";
  }
}

/**
 * Resolve the wire-format thinking control for a given (mode, model, format).
 *
 * Returns one of:
 * - `{ type: "disabled" }`   → send `thinking: {"type":"disabled"}`
 * - `{ type: "adaptive" }`   → send `thinking: {"type":"adaptive"}`
 * - `undefined`               → omit the field entirely (auto / model-controlled)
 */
export function resolveThinkingControl(
  mode: ThinkingMode,
  model: ModelInfo,
  format: ApiFormat,
): { type: "adaptive" } | { type: "disabled" } | undefined {
  if (mode === "adaptive") {
    return { type: "adaptive" };
  }
  if (mode === "off") {
    return { type: "disabled" };
  }
  // mode === "auto": honor the endpoint's own default.
  if (model.id === "MiniMax-M3") {
    if (format === "anthropic-compat") {
      // Anthropic-compat: thinking is OFF by default for M3.
      return undefined;
    }
    // OpenAI-compat: thinking is ON by default for M3.
    return { type: "adaptive" };
  }
  // M2.x cannot disable thinking; auto → omit so the endpoint defaults to ON.
  return undefined;
}

/**
 * Legacy boolean accessor retained for existing call sites. Resolves the
 * current mode and the active format into a yes/no for the M3 default.
 *
 * Returns `true` when thinking is enabled in a way that would actually turn
 * it on for M3 (i.e. `adaptive`, or `auto` on the OpenAI endpoint). Returns
 * `false` for `off` or `auto` on the Anthropic endpoint (which is M3-off by
 * default).
 */
export function isThinkingEnabled(): boolean {
  const mode = getThinkingMode();
  if (mode === "adaptive") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  // auto: depends on the endpoint. Resolve against M3 + current format.
  const format = getApiFormat();
  return format === "openai-compat";
}

export function getApiFormat(): ApiFormat {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const value = config.get<unknown>(API_FORMAT_KEY);
  return value === "anthropic-compat" ? "anthropic-compat" : "openai-compat";
}

export function apiFormatLabel(format: ApiFormat): string {
  return format === "anthropic-compat"
    ? "Anthropic SDK (Messages API)"
    : "OpenAI SDK (Chat Completions)";
}

export async function setApiFormat(format: ApiFormat): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update(API_FORMAT_KEY, format, vscode.ConfigurationTarget.Global);
}

/**
 * Legacy setter kept for the old `toggleThinking` command. Maps the new mode
 * world back onto the legacy boolean.
 */
export async function setThinkingEnabled(enabled: boolean): Promise<void> {
  await setThinkingMode(enabled ? "adaptive" : "off");
}

export function getAnthropicBaseUrl(): string {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const url = config.get<string>(ANTHROPIC_BASE_URL_KEY);
  if (typeof url === "string" && url.trim().length > 0) {
    return url.trim();
  }
  return "https://api.minimax.io/anthropic";
}

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
  const format = getApiFormat();
  const sdkLabel = format === "anthropic-compat" ? "Anthropic SDK" : "OpenAI SDK";
  const mode = getThinkingMode();
  const thinkingLabel =
    mode === "off"
      ? "thinking off"
      : mode === "adaptive"
        ? "thinking on (adaptive)"
        : `thinking ${mode}`;
  return visibleModels.map(
    (model) =>
      ({
        id: model.id,
        name: model.name,
        detail: `Token Plan · ${sdkLabel}`,
        tooltip: `${model.name} -- in ${model.maxInputTokens.toLocaleString()} / out ${model.maxOutputTokens.toLocaleString()} max tokens (context up to ${model.contextLength.toLocaleString()}) · ${sdkLabel}${model.id === "MiniMax-M3" ? ` · ${thinkingLabel}` : ""}`,
        family: "minimax",
        version: getModelVersion(model.id),
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        isUserSelectable: true,
        capabilities: {
          toolCalling: true,
          imageInput: model.id === "MiniMax-M3",
        },
      }) as vscode.LanguageModelChatInformation,
  );
}

function getModelVersion(modelId: ModelInfo["id"]): string {
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
  }
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

// Suppress unused-type-import lint for ModelId: this file no longer uses it
// directly, but downstream consumers reference the export from this module.
export type { ModelId };
