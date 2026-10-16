import { createHash } from "node:crypto";
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

  private availableModels: readonly ModelInfo[] = [];
  private catalogScope: string | undefined;
  private refreshGeneration = 0;
  private lastCatalogWarning: string | undefined;
  private readonly catalogOutput = vscode.window.createOutputChannel("MiniMax");
  private devCache: ModelsDevCache | undefined;
  /** The key VS Code hands us (Manage Models); requests use it, so refreshes do too. */
  private refreshKey: string | undefined;
  private readonly refreshTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly apiClient: MiniMaxClient,
    private readonly authManager: MiniMaxAuthentication,
    private readonly tokenCounter: TokenCounter,
    private readonly context: vscode.ExtensionContext,
  ) {
    void this.refreshModels();
    this.refreshTimer = setInterval(() => {
      void this.refreshModels();
    }, 30 * 60 * 1000);
  }

  dispose(): void {
    ++this.refreshGeneration;
    clearInterval(this.refreshTimer);
    this.catalogOutput.dispose();
    this.modelsChangedEmitter.dispose();
  }

  /** Re-fetch GET {baseUrl}/models, resolve limits from the provider fields
   * first and models.dev second, persist, and fire onDidChange only when the
   * served list actually changed. */
  async refreshModels(): Promise<void> {
    let apiKey = this.refreshKey;
    try {
      apiKey ??= await this.authManager.getApiKey();
      apiKey = this.refreshKey ?? apiKey;
    } catch {
      return;
    }
    if (!apiKey || apiKey.trim().length === 0) {
      return;
    }
    const baseUrl = (getApiBaseUrl() ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    const scope = catalogScope(baseUrl, apiKey.trim());
    const generation = ++this.refreshGeneration;
    if (scope !== this.catalogScope) {
      this.catalogScope = scope;
      const persisted = readPersistedCatalog(this.context.globalState, scope);
      this.availableModels = persisted.models;
      this.devCache = persisted.devCache;
      this.modelApiKeys.clear();
      this.notifyModelsChanged();
    }
    let live: LiveModelEntry[];
    try {
      live = await fetchLiveModelCatalog(baseUrl, apiKey.trim());
    } catch (error) {
      if (generation === this.refreshGeneration) {
        this.reportCatalogWarning("Could not refresh the MiniMax model list", baseUrl, error);
      }
      return;
    }
    if (generation !== this.refreshGeneration) return;
    const ids = live.map((entry) => entry.id);
    let nextDevCache: ModelsDevCache;
    try {
      nextDevCache = await resolveModelsDev(baseUrl, ids, this.devCache);
      if (generation === this.refreshGeneration) this.lastCatalogWarning = undefined;
    } catch (error) {
      if (generation !== this.refreshGeneration) return;
      // Metadata enrichment must never veto the authoritative live model ids.
      nextDevCache = this.devCache ?? { models: {} };
      this.reportCatalogWarning("Could not refresh models.dev metadata; using cached metadata or default limits for live models", baseUrl, error);
    }
    if (generation !== this.refreshGeneration) return;
    const byId = new Map(live.map((entry) => [entry.id, entry]));
    const built: ModelInfo[] = [];
    const defaultedIds: string[] = [];
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) {
        continue;
      }
      const dev = nextDevCache.models[id] ?? undefined;
      // A model MiniMax lists before models.dev catalogs it still shows up, with safe limits, corrected on the next refresh once models.dev knows it.
      let context = entry.context_window ?? dev?.limit?.context;
      let output = entry.max_output_tokens ?? dev?.limit?.output;
      let usedDefault = false;
      if (typeof context !== "number" || !Number.isFinite(context) || context <= 0) {
        context = 131072;
        usedDefault = true;
      }
      if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) {
        output = 32768;
        usedDefault = true;
      }
      if (usedDefault) {
        defaultedIds.push(id);
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
    if (defaultedIds.length > 0) {
      console.info(`[minimax] Using default limits for: ${defaultedIds.join(", ")}.`);
    }
    this.catalogOutput.appendLine(`Loaded ${built.length} live chat models from ${baseUrl}/models.`);
    this.devCache = nextDevCache;
    if (JSON.stringify(built) === JSON.stringify(this.availableModels)) {
      return;
    }
    this.availableModels = built;
    try {
      await this.context.globalState.update(MODEL_CATALOG_CACHE_KEY, {
        scope,
        devCache: nextDevCache,
        models: built,
      });
    } catch {
      // Cache is best-effort; the in-memory list is already updated.
    }
    if (generation === this.refreshGeneration) this.notifyModelsChanged();
  }

  private reportCatalogWarning(message: string, baseUrl: string, error: unknown): void {
    // Never log response bodies or raw network errors: they may contain credentials.
    const status = error instanceof Error ? /HTTP (\d{3})/.exec(error.message)?.[1] : undefined;
    const warning = `${message}${status ? ` (HTTP ${status})` : ""}. Check minimax.apiBaseUrl, the matching region's M Plan Subscription Key, and network access. See Output > MiniMax.`;
    this.catalogOutput.appendLine(`${message} at ${baseUrl}${status ? ` (HTTP ${status})` : ""}.`);
    if (this.lastCatalogWarning !== warning) {
      this.lastCatalogWarning = warning;
      void vscode.window.showWarningMessage(warning);
    }
  }

  notifyModelsChanged(): void {
    this.modelsChangedEmitter.fire();
  }

  /** Refresh and await a changed account/endpoint before serving its catalog. */
  private async syncCatalog(apiKey: string): Promise<void> {
    const baseUrl = getApiBaseUrl() ?? DEFAULT_API_BASE_URL;
    if (catalogScope(baseUrl, apiKey) === this.catalogScope && apiKey === this.refreshKey && this.availableModels.length > 0) {
      return;
    }
    this.refreshKey = apiKey;
    await this.refreshModels();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const optionsWithConfig = options as PrepareOptionsWithConfiguration;
    const configuredApiKey = this.extractConfiguredApiKey(optionsWithConfig);

    if (!configuredApiKey) {
      this.modelApiKeys.clear();
      return [];
    }

    await this.syncCatalog(configuredApiKey);
    // An overlapping request for another account/region may have superseded us.
    if (this.catalogScope !== catalogScope(getApiBaseUrl() ?? DEFAULT_API_BASE_URL, configuredApiKey)) {
      return [];
    }
    const models = modelsWithApiKey(this.availableModels);
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

        if (latestReasoning || reasoningContent) {
          inlineParser.reasoningSeparated();
        }
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

const MODEL_CATALOG_CACHE_KEY = "minimax.modelCatalog.v3";

function catalogScope(baseUrl: string, apiKey: string): string {
  // Bind the cache to the endpoint AND account without persisting the API key.
  return createHash("sha256").update(JSON.stringify([baseUrl.trim().replace(/\/+$/, ""), apiKey.trim()])).digest("hex");
}

interface PersistedCatalog {
  scope?: string;
  devCache?: unknown;
  models?: unknown;
}

function readPersistedCatalog(globalState: vscode.Memento, scope: string): {
  devCache: ModelsDevCache | undefined;
  models: ModelInfo[];
} {
  try {
    const cached = globalState.get<PersistedCatalog>(MODEL_CATALOG_CACHE_KEY);
    if (cached?.scope !== scope) return { devCache: undefined, models: [] };
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
