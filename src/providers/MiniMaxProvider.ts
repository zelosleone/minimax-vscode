import * as vscode from "vscode";
import { MiniMaxClient, type ChatOptions } from "../api/MiniMaxClient";
import { MiniMaxError } from "../api/MiniMaxError";
import {
  DEFAULT_API_BASE_URL,
  fetchLiveModelCatalog,
  humanizeModelId,
  type LiveModelEntry,
  type ModelInfo,
} from "../api/types";
import {
  reasoningChoices,
  reasoningRequestFields,
  resolveModelsDev,
  resolveReasoningChoice,
  tokenLimits,
  type ModelsDevCache,
} from "../modelsDev";
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

type ResponseOptionsWithEffort = vscode.ProvideLanguageModelChatResponseOptions & {
  modelConfiguration?: { reasoningEffort?: unknown };
  configuration?: { reasoningEffort?: unknown };
};

export class MiniMaxProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChangedEmitter.event;

  private readonly modelApiKeys = new Map<string, string>();

  private availableModels: readonly ModelInfo[];
  private devCache: ModelsDevCache | undefined;
  private readonly refreshTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly apiClient: MiniMaxClient,
    private readonly authManager: MiniMaxAuthentication,
    private readonly tokenCounter: TokenCounter,
    private readonly context: vscode.ExtensionContext,
  ) {
    const persisted = readPersistedCatalog(context.globalState);
    this.availableModels = persisted.models;
    this.devCache = persisted.devCache;
    void this.refreshModels();
    this.refreshTimer = setInterval(() => {
      void this.refreshModels();
    }, 30 * 60 * 1000);
  }

  dispose(): void {
    clearInterval(this.refreshTimer);
    this.modelsChangedEmitter.dispose();
  }

  /** Re-fetch GET {baseUrl}/models, resolve limits from the provider fields
   * first and models.dev second, persist, and fire onDidChange only when the
   * served list actually changed. */
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
    let live: LiveModelEntry[];
    try {
      live = await fetchLiveModelCatalog(baseUrl, apiKey.trim());
    } catch {
      return;
    }
    const ids = live.map((entry) => entry.id);
    let nextDevCache: ModelsDevCache;
    try {
      nextDevCache = await resolveModelsDev(baseUrl, ids, this.devCache);
    } catch {
      // models.dev failed: keep the previous catalog, do not invent data.
      return;
    }
    const byId = new Map(live.map((entry) => [entry.id, entry]));
    const built: ModelInfo[] = [];
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) {
        continue;
      }
      const dev = nextDevCache.models[id] ?? undefined;
      const context = entry.context_window ?? dev?.limit?.context;
      const output = entry.max_output_tokens ?? dev?.limit?.output;
      if (
        typeof context !== "number" ||
        typeof output !== "number" ||
        !Number.isFinite(context) ||
        !Number.isFinite(output) ||
        context <= 0 ||
        output <= 0
      ) {
        console.warn(`[minimax] Skipping live model "${id}": no context/output limits from the provider or models.dev.`);
        continue;
      }
      const limits = tokenLimits(context, output);
      const inputModalities = entry.input_modalities ?? dev?.modalities?.input;
      built.push({
        id,
        name: entry.name ?? dev?.name ?? humanizeModelId(id),
        contextLength: limits.maxContextWindowTokens,
        maxInputTokens: limits.maxInputTokens,
        maxOutputTokens: limits.maxOutputTokens,
        imageInput:
          Array.isArray(inputModalities) && inputModalities.includes("image"),
        toolCall: dev?.tool_call !== false,
        choices: reasoningChoices(dev?.reasoning_options, undefined),
      });
    }
    this.devCache = nextDevCache;
    if (JSON.stringify(built) === JSON.stringify(this.availableModels)) {
      return;
    }
    this.availableModels = built;
    try {
      await this.context.globalState.update(MODEL_CATALOG_CACHE_KEY, {
        devCache: nextDevCache,
        models: built,
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
    return Promise.resolve(this.tokenCounter.estimatePayload(convertMessages([text])));
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
    const converted = convertMessages(messages);
    const tools = convertTools(options.tools);
    const requestChars = this.tokenCounter.payloadChars({ messages: converted, tools: tools ?? [] });

    const optionsWithEffort = options as ResponseOptionsWithEffort;
    const configuredEffort =
      optionsWithEffort.modelConfiguration?.reasoningEffort ??
      optionsWithEffort.configuration?.reasoningEffort;
    const reasoningFields = reasoningRequestFields(
      resolveReasoningChoice(resolvedModel.choices, configuredEffort),
      "adaptive",
    );

    const chatOptions: ChatOptions = {
      maxTokens: resolveMaxTokens(options, resolvedModel),
      temperature: resolveTemperature(options),
      apiKey,
      baseUrl: getApiBaseUrl(),
      tools,
      toolChoice: resolveToolChoice(options, tools),
      reasoningSplit: true,
      reasoningFields,
    };
    const topP = resolveTopP(options);
    if (topP !== undefined) {
      chatOptions.topP = topP;
    }

    const stream = this.apiClient.streamChat(
      resolvedModel.id,
      converted,
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

      this.reportUsage(chunk, requestChars, progress);
    }
  }

  private reportUsage(
    chunk: { usage?: unknown },
    requestChars: number,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    const usage = chunk.usage as
      | {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          total_tokens?: unknown;
          prompt_tokens_details?: { cached_tokens?: unknown };
        }
      | undefined;
    if (!usage || typeof usage.prompt_tokens !== "number" || usage.prompt_tokens <= 0) {
      return;
    }
    this.tokenCounter.calibrate(requestChars, usage.prompt_tokens);
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
    const payload = JSON.stringify({
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
      total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
      prompt_tokens_details: {
        cached_tokens: typeof cachedTokens === "number" ? cachedTokens : 0,
      },
    });
    const DataPartCtor = vscode.LanguageModelDataPart as unknown as new (
      data: Uint8Array,
      mimeType: string,
    ) => vscode.LanguageModelResponsePart;
    progress.report(new DataPartCtor(new TextEncoder().encode(payload), "usage"));
  }

  private findModel(id: string): ModelInfo | undefined {
    return this.availableModels.find((model) => model.id === id);
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

const MODEL_CATALOG_CACHE_KEY = "minimax.modelCatalog.v2";

interface PersistedCatalog {
  devCache?: unknown;
  models?: unknown;
}

function readPersistedCatalog(globalState: vscode.Memento): {
  devCache: ModelsDevCache | undefined;
  models: ModelInfo[];
} {
  try {
    const cached = globalState.get<PersistedCatalog>(MODEL_CATALOG_CACHE_KEY);
    const devCache = isValidDevCache(cached?.devCache) ? cached.devCache : undefined;
    const models = Array.isArray(cached?.models)
      ? cached.models.filter(isValidPersistedModel)
      : [];
    return { devCache, models };
  } catch {
    return { devCache: undefined, models: [] };
  }
}

function isValidDevCache(value: unknown): value is ModelsDevCache {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { models?: unknown };
  return !!candidate.models && typeof candidate.models === "object" && !Array.isArray(candidate.models);
}

function isValidPersistedModel(value: unknown): value is ModelInfo {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.contextLength !== "number" ||
    typeof candidate.maxInputTokens !== "number" ||
    typeof candidate.maxOutputTokens !== "number" ||
    typeof candidate.imageInput !== "boolean"
  ) {
    return false;
  }
  if (candidate.choices !== undefined && !isValidPersistedChoices(candidate.choices)) {
    return false;
  }
  return true;
}

function isValidPersistedChoices(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { values?: unknown; defaultValue?: unknown };
  return (
    Array.isArray(candidate.values) &&
    candidate.values.every((entry) => typeof entry === "string") &&
    typeof candidate.defaultValue === "string"
  );
}
