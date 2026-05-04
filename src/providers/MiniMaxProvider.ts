import * as vscode from "vscode";
import { MiniMaxClient, type ChatOptions } from "../api/MiniMaxClient";
import { MiniMaxError } from "../api/MiniMaxError";
import { MiniMaxAuthentication } from "./MiniMaxAuthentication";
import { MiniMaxErrorMapper } from "./ErrorMapper";
import { TokenCounter } from "../utils/TokenCounter";
import { getModelById, resolveModelIdForApi } from "../api/types";
import {
  getThinkingPartCtor,
  getLatestReasoningUpdate,
  reportReasoning,
  InlineThinkingParser,
} from "../utils/ThinkingHelper";
import { convertMessages } from "../utils/MessageConverter";
import {
  convertTools,
  resolveToolChoice,
  accumulateToolCalls,
  isToolCallFinish,
  reportToolCalls,
  type AccumulatedToolCall,
} from "../utils/ToolConverter";
import {
  getApiBaseUrl,
  modelsWithApiKey,
  resolveMaxTokens,
  resolveTemperature,
  resolveTopP,
} from "../utils/ModelConfig";

type PrepareOptionsWithConfiguration = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: Record<string, unknown>;
};

export class MiniMaxProvider implements vscode.LanguageModelChatProvider {
  private readonly modelsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChangedEmitter.event;

  private readonly modelApiKeys = new Map<string, string>();

  constructor(
    private readonly apiClient: MiniMaxClient,
    private readonly authManager: MiniMaxAuthentication,
    private readonly tokenCounter: TokenCounter,
  ) {}

  notifyModelsChanged(): void {
    this.modelsChangedEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const optionsWithConfig = options as PrepareOptionsWithConfiguration;
    const configuredApiKey = this.extractConfiguredApiKey(optionsWithConfig);
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

