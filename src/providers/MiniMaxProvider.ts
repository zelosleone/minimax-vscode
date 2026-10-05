import * as vscode from "vscode";
import { MiniMaxClient, type ChatOptions } from "../api/MiniMaxClient";
import { MiniMaxError } from "../api/MiniMaxError";
import {
  DEFAULT_API_BASE_URL,
  SUPPORTED_MODELS,
  fetchLiveModelCatalog,
  getModelById,
  mergeModelCatalog,
  resolveModelIdForApi,
  type ModelInfo,
} from "../api/types";
import { convertMessages } from "../utils/MessageConverter";
import {
  getApiBaseUrl,
  modelsWithApiKey,
  resolveMaxTokens,
  resolveTemperature,
  resolveTopP,
} from "../utils/ModelConfig";
import {
  getLatestReasoningUpdate,
  getThinkingPartCtor,
  InlineThinkingParser,
  reportReasoning,
} from "../utils/ThinkingHelper";
import { TokenCounter } from "../utils/TokenCounter";
import {
  accumulateToolCalls,
  convertTools,
  isToolCallFinish,
  reportToolCalls,
  resolveToolChoice,
  type AccumulatedToolCall,
} from "../utils/ToolConverter";
import { MiniMaxErrorMapper } from "./ErrorMapper";
import { MiniMaxAuthentication } from "./MiniMaxAuthentication";

type PrepareOptionsWithConfiguration = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: Record<string, unknown>;
};

export class MiniMaxProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChangedEmitter.event;

  private readonly modelApiKeys = new Map<string, string>();
  private lastPromptTokens = 0;

  private availableModels: readonly ModelInfo[];
  private readonly refreshTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly apiClient: MiniMaxClient,
    private readonly authManager: MiniMaxAuthentication,
    private readonly tokenCounter: TokenCounter,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.availableModels = readCachedCatalog(context.globalState);
    void this.refreshModels();
    this.refreshTimer = setInterval(() => {
      void this.refreshModels();
    }, 30 * 60 * 1000);
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
    this.modelsChangedEmitter.dispose();
  }

  /** Re-fetch GET {baseUrl}/models, merge with the known table, persist the
   * catalog, and fire onDidChange only when the id list actually changed. */
  async refreshModels(): Promise<void> {
    let apiKey: string | undefined;
    try {
      apiKey = await this.authManager.getApiKey();
    } catch {
      return;
    }
    if (!apiKey || apiKey.trim().length === 0) {
      return;
    }
    const baseUrl = getApiBaseUrl() ?? DEFAULT_API_BASE_URL;
    let liveIds: string[];
    try {
      liveIds = await fetchLiveModelCatalog(baseUrl, apiKey.trim());
    } catch {
      return;
    }
    const merged = mergeModelCatalog(liveIds);
    if (sameModelIds(this.availableModels, merged)) {
      return;
    }
    this.availableModels = merged;
    try {
      await this.context.globalState.update(MODEL_CATALOG_CACHE_KEY, {
        savedAt: Date.now(),
        models: merged,
      });
    } catch {
      // Cache is best-effort; the in-memory list is already updated.
    }
    this.notifyModelsChanged();
  }

  notifyModelsChanged(): void {
    this.modelsChangedEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const optionsWithConfig = options as PrepareOptionsWithConfiguration;
    const configuredApiKey = this.extractConfiguredApiKey(optionsWithConfig);
    const models = modelsWithApiKey(this.availableModels);

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
    const resolvedModel = this.findModel(model.id);
    if (!resolvedModel) {
      throw new Error(`Unsupported model "${model.id}" for MiniMax (coding / Token Plan).`);
    }

    let reasoningBuffer = "";
    const thinkingPartCtor = getThinkingPartCtor();
    const inlineParser = new InlineThinkingParser();
    const pendingToolCalls = new Map<number, AccumulatedToolCall>();
    let toolCallsEmitted = false;
    const tools = convertTools(options.tools);

    const chatOptions: ChatOptions = {
      maxTokens: resolveMaxTokens(options, resolvedModel),
      temperature: resolveTemperature(options),
      apiKey,
      baseUrl: getApiBaseUrl(),
      tools,
      toolChoice: resolveToolChoice(options, tools),
      reasoningSplit: true,
    };
    const topP = resolveTopP(options);
    if (topP !== undefined) {
      chatOptions.topP = topP;
    }

    const stream = this.apiClient.streamChat(
      resolveModelIdForApi(resolvedModel.id),
      convertMessages(messages),
      chatOptions,
      token,
    );

    for await (const chunk of stream) {
      if (token.isCancellationRequested) {
        return;
      }

      for (const choice of chunk.choices) {
        const latestReasoning = getLatestReasoningUpdate(choice);
        const reasoningContent = (choice.delta as { reasoning_content?: string } | undefined)
          ?.reasoning_content;

        if (latestReasoning) {
          const newReasoning = latestReasoning.text.startsWith(reasoningBuffer)
            ? latestReasoning.text.slice(reasoningBuffer.length)
            : latestReasoning.text;

          if (newReasoning) {
            reportReasoning(progress, thinkingPartCtor, newReasoning, latestReasoning);
            reasoningBuffer = latestReasoning.text;
          }
        } else if (reasoningContent) {
          if (thinkingPartCtor) {
            progress.report(new thinkingPartCtor(reasoningContent) as vscode.LanguageModelResponsePart);
          } else {
            progress.report(new vscode.LanguageModelTextPart(`[thinking]${reasoningContent}[/thinking]`));
          }
        }

        const rawContent = choice.delta?.content;
        if (rawContent) {
          const { cleaned, thinking: inlineThinking } = inlineParser.feed(rawContent);
          if (inlineThinking) {
            if (thinkingPartCtor) {
              progress.report(new thinkingPartCtor(inlineThinking) as vscode.LanguageModelResponsePart);
            } else {
              progress.report(new vscode.LanguageModelTextPart(`[thinking]${inlineThinking}[/thinking]`));
            }
          }
          if (cleaned) {
            progress.report(new vscode.LanguageModelTextPart(cleaned));
          }
        }

        accumulateToolCalls(choice, pendingToolCalls);
        if (!toolCallsEmitted && isToolCallFinish(choice)) {
          reportToolCalls(progress, pendingToolCalls);
          toolCallsEmitted = true;
        }
      }
      
      if (chunk.usage?.prompt_tokens) {
        this.lastPromptTokens = chunk.usage.prompt_tokens;
      }
    }
  }

  private findModel(id: string): ModelInfo | undefined {
    const live = this.availableModels.find((model) => model.id === id);
    return live ?? getModelById(id);
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

const MODEL_CATALOG_CACHE_KEY = "minimax.modelCatalog.v1";

interface ModelCatalogCache {
  savedAt?: unknown;
  models?: unknown;
}

function readCachedCatalog(globalState: vscode.Memento): readonly ModelInfo[] {
  try {
    const cached = globalState.get<ModelCatalogCache>(MODEL_CATALOG_CACHE_KEY);
    if (!cached || !Array.isArray(cached.models)) {
      return SUPPORTED_MODELS;
    }
    const models = cached.models.filter(isValidCachedModel);
    return models.length > 0 ? models : SUPPORTED_MODELS;
  } catch {
    return SUPPORTED_MODELS;
  }
}

function isValidCachedModel(value: unknown): value is ModelInfo {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.contextLength === "number" &&
    typeof candidate.maxInputTokens === "number" &&
    typeof candidate.maxOutputTokens === "number"
  );
}

function sameModelIds(a: readonly ModelInfo[], b: readonly ModelInfo[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((model, index) => model.id === b[index]?.id);
}
