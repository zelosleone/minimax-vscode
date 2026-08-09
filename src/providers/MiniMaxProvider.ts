import * as vscode from "vscode";
import { MiniMaxError } from "../api/MiniMaxError";
import { getModelById, resolveModelIdForApi } from "../api/types";
import type { MinimaxStreamClient } from "../api/MinimaxStreamClient";
import { MiniMaxOpenAIClient } from "../api/MiniMaxOpenAIClient";
import { MiniMaxAnthropicClient } from "../api/MiniMaxAnthropicClient";
import { convertMessages } from "../utils/MessageConverter";
import {
  getApiBaseUrl,
  getAnthropicBaseUrl,
  getApiFormat,
  getThinkingMode,
  isThinkingMode,
  modelsWithApiKey,
  resolveMaxTokens,
  resolveTemperature,
  resolveThinkingControl,
  resolveTopP,
  setApiFormat,
  setThinkingMode,
  type ApiFormat,
  type ThinkingMode,
} from "../utils/ModelConfig";
import {
  getThinkingPartCtor,
  InlineThinkingParser,
} from "../utils/ThinkingHelper";
import { TokenCounter } from "../utils/TokenCounter";
import {
  convertTools,
  resolveToolChoice,
  type AccumulatedToolCall,
} from "../utils/ToolConverter";
import { MiniMaxErrorMapper } from "./ErrorMapper";
import { MiniMaxAuthentication } from "./MiniMaxAuthentication";

type PrepareOptionsWithConfiguration = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: Record<string, unknown>;
};

export class MiniMaxProvider implements vscode.LanguageModelChatProvider {
  private readonly modelsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChangedEmitter.event;

  private readonly modelApiKeys = new Map<string, string>();

  constructor(
    private readonly authManager: MiniMaxAuthentication,
    private readonly tokenCounter: TokenCounter,
  ) { }

  private createClient(): MinimaxStreamClient {
    const format = getApiFormat();
    if (format === "anthropic-compat") {
      return new MiniMaxAnthropicClient(getAnthropicBaseUrl());
    }
    return new MiniMaxOpenAIClient(getApiBaseUrl());
  }

  notifyModelsChanged(): void {
    this.modelsChangedEmitter.fire();
  }

  clearApiKeyCache(): void {
    this.modelApiKeys.clear();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const optionsWithConfig = options as PrepareOptionsWithConfiguration;
    const configuredApiKey = this.extractConfiguredApiKey(optionsWithConfig);
    await this.applyConfiguredPreferences(optionsWithConfig);
    const models = modelsWithApiKey();

    if (!configuredApiKey) {
      this.modelApiKeys.clear();
      return [];
    }

    this.modelApiKeys.clear();
    for (const model of models) {
      this.modelApiKeys.set(model.id, configuredApiKey);
    }

    return models;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const apiKey =
      this.modelApiKeys.get(model.id) ?? (await this.authManager.getOrPromptApiKey());

    if (!apiKey) {
      throw new Error("API key not configured. Use the API key navigation action in the MiniMax model picker.");
    }

    try {
      await this.streamResponse(model, messages, options, progress, token, apiKey);
    } catch (error) {
      if (error instanceof MiniMaxError && error.statusCode === 401) {
        await this.authManager.deleteApiKey();
        this.notifyModelsChanged();
        const newKey = await this.authManager.promptForApiKey();
        this.modelApiKeys.clear();
        if (newKey) {
          this.modelApiKeys.set(model.id, newKey);
          this.notifyModelsChanged();
          await this.streamResponse(model, messages, options, progress, token, newKey);
          return;
        }
        this.notifyModelsChanged();
        throw new Error("Invalid API key. Please set a new one using the API key navigation action in the MiniMax model picker.");
      }
      await MiniMaxErrorMapper.throwMappedError(error, this.authManager);
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Thenable<number> {
    if (typeof text === "string") {
      return Promise.resolve(this.tokenCounter.estimateTokens(text));
    }

    let tokens = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        tokens += this.tokenCounter.estimateTokens(part.value);
      } else if (part instanceof vscode.LanguageModelDataPart) {
        tokens += Math.ceil(part.data.length / 4);
      }
    }
    return Promise.resolve(tokens);
  }

  private async streamResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    apiKey: string,
  ): Promise<void> {
    const resolvedModel = getModelById(model.id);
    if (!resolvedModel) {
      throw new Error(`Unsupported model "${model.id}" for MiniMax (coding / Token Plan).`);
    }

    const thinkingPartCtor = getThinkingPartCtor();
    const inlineParser = new InlineThinkingParser();
    const pendingToolCalls = new Map<number, AccumulatedToolCall>();
    const emittedToolCallIndices = new Set<number>();
    let pendingTrailingContent = "";
    const tools = convertTools(options.tools);

    // Split system message out so the Anthropic adapter can put it in the
    // `system` field, while the OpenAI adapter keeps it in the messages array.
    const converted = convertMessages(messages);
    const systemParts: string[] = [];
    const nonSystemMessages: typeof converted = [];
    for (const m of converted) {
      if (m.role === "system") {
        systemParts.push(typeof m.content === "string" ? m.content : "");
      } else {
        nonSystemMessages.push(m);
      }
    }

    const toolChoice = resolveToolChoice(options, tools);
    const topP = resolveTopP(options);

    const client = this.createClient();
    const thinkingMode = getThinkingMode();
    const thinkingControl = resolveThinkingControl(thinkingMode, resolvedModel, getApiFormat());
    const stream = client.streamChat({
      apiKey,
      model: resolveModelIdForApi(resolvedModel.id),
      maxTokens: resolveMaxTokens(options, resolvedModel),
      temperature: resolveTemperature(options),
      topP,
      tools,
      toolChoice: toolChoice ?? "auto",
      reasoningSplit: true,
      ...(thinkingControl ? { thinking: thinkingControl } : {}),
      cancellationToken: token,
      messages: nonSystemMessages,
      systemPrompt: systemParts.join("\n\n") || undefined,
    });

    for await (const event of stream) {
      if (token.isCancellationRequested) {
        return;
      }
      switch (event.kind) {
        case "thinking": {
          if (event.text && thinkingPartCtor) {
            progress.report(
              new thinkingPartCtor(event.text) as vscode.LanguageModelResponsePart,
            );
          } else if (event.text) {
            progress.report(
              new vscode.LanguageModelTextPart(`[thinking]${event.text}[/thinking]`),
            );
          }
          break;
        }
        case "text": {
          const { cleaned, thinking: inlineThinking } = inlineParser.feed(event.text);
          if (inlineThinking && thinkingPartCtor) {
            progress.report(
              new thinkingPartCtor(inlineThinking) as vscode.LanguageModelResponsePart,
            );
          } else if (inlineThinking) {
            progress.report(
              new vscode.LanguageModelTextPart(`[thinking]${inlineThinking}[/thinking]`),
            );
          }
          if (cleaned) {
            // Buffer trailing content so a stray </think> arriving in a later event
            // can be paired and discarded before the user sees it.
            const combined = pendingTrailingContent + cleaned;
            const strayClose = combined.indexOf("</think>");
            if (strayClose !== -1) {
              const safe = combined.slice(0, strayClose);
              if (safe) {
                progress.report(new vscode.LanguageModelTextPart(safe));
              }
              pendingTrailingContent = "";
            } else {
              pendingTrailingContent = combined;
            }
          }
          break;
        }
        case "tool_use_start": {
          const current: AccumulatedToolCall =
            pendingToolCalls.get(event.index) ?? {
              index: event.index,
              arguments: "",
            };
          current.id = event.id;
          current.name = event.name;
          pendingToolCalls.set(event.index, current);
          break;
        }
        case "tool_use_delta": {
          const current: AccumulatedToolCall =
            pendingToolCalls.get(event.index) ?? {
              index: event.index,
              arguments: "",
            };
          current.arguments += event.partialJson;
          pendingToolCalls.set(event.index, current);
          break;
        }
        case "tool_use_stop": {
          const call = pendingToolCalls.get(event.index);
          if (call) {
            this.emitToolCall(progress, call, emittedToolCallIndices);
          }
          break;
        }
        case "content_block_start":
        case "usage":
          // Informational only on these paths; nothing to do in the provider loop.
          break;
        case "finish": {
          this.emitToolCalls(progress, pendingToolCalls, emittedToolCallIndices);
          break;
        }
        default: {
          // Exhaustiveness check.
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    }

    // Flush any content buffered while waiting for a possible stray </think>.
    if (pendingTrailingContent) {
      progress.report(new vscode.LanguageModelTextPart(pendingTrailingContent));
      pendingTrailingContent = "";
    }
  }

  private emitToolCalls(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    pendingToolCalls: Map<number, AccumulatedToolCall>,
    emittedIndices: Set<number>,
  ): void {
    const ordered = [...pendingToolCalls.values()].sort((a, b) => a.index - b.index);
    for (const call of ordered) {
      this.emitToolCall(progress, call, emittedIndices);
    }
  }

  private emitToolCall(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    call: AccumulatedToolCall,
    emittedIndices: Set<number>,
  ): void {
    if (!call.id || !call.name || emittedIndices.has(call.index)) {
      return;
    }
    emittedIndices.add(call.index);
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(call.arguments);
    } catch {
      parsed = {};
    }
    progress.report(
      new vscode.LanguageModelToolCallPart(call.id, call.name, parsed as object),
    );
  }

  /**
   * The chat UI's "Manage Language Models" flow passes the values entered for
   * the `languageModelChatProviders` configuration schema (apiFormat,
   * thinkingMode) alongside the API key. Persist them to user settings so
   * the rest of the extension picks them up.
   *
   * `thinkingMode` is the new tri-state dropdown exposed next to the model
   * picker; we still accept the legacy `thinkingEnabled` boolean for users
   * who migrated from the previous settings-only UI.
   */
  private async applyConfiguredPreferences(
    options: PrepareOptionsWithConfiguration,
  ): Promise<void> {
    const config = options.configuration;
    if (!config || typeof config !== "object") {
      return;
    }

    const format = config.apiFormat;
    if (
      (format === "openai-compat" || format === "anthropic-compat") &&
      format !== getApiFormat()
    ) {
      await setApiFormat(format as ApiFormat);
    }

    const mode = config.thinkingMode;
    if (isThinkingMode(mode) && mode !== getThinkingMode()) {
      await setThinkingMode(mode);
      return;
    }
    // Legacy boolean: only apply if the new tri-state key wasn't set in this
    // same picker dialog (otherwise we'd clobber an explicit dropdown choice).
    if (config.thinkingMode === undefined) {
      const legacy = config.thinkingEnabled;
      if (typeof legacy === "boolean") {
        const mapped: ThinkingMode = legacy ? "adaptive" : "off";
        if (mapped !== getThinkingMode()) {
          await setThinkingMode(mapped);
        }
      }
    }
  }

  private extractConfiguredApiKey(
    options: PrepareOptionsWithConfiguration,
  ): string | undefined {
    const config = options.configuration;
    if (!config || typeof config !== "object") {
      return undefined;
    }

    const apiKey = config.apiKey;
    if (typeof apiKey !== "string") {
      return undefined;
    }

    const normalized = apiKey.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
}
