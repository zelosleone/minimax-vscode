import * as vscode from "vscode";
import { MiniMaxClient, MiniMaxError } from "../api/MiniMaxClient";
import { MiniMaxAuthentication } from "./MiniMaxAuthentication";
import { TokenCounter } from "../utils/TokenCounter";
import {
  MiniMaxAssistantMessage,
  MiniMaxMessage,
  MiniMaxReasoningDetail,
  MiniMaxToolDefinition,
  MiniMaxToolMessage,
  MiniMaxToolCall,
  getModelById,
  SUPPORTED_MODELS,
} from "../api/types";

interface ModelWithApiKey extends vscode.LanguageModelChatInformation {
  __minimaxApiKey?: string;
}

type PrepareOptionsWithConfiguration = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: Record<string, unknown>;
};

const DEFAULT_TEMPERATURE = 1;
const DEFAULT_MAX_TOKENS = 8192;
const CONFIG_SECTION = "minimax";
const VISIBLE_MODELS_KEY = "visibleModels";

interface ReasoningUpdate {
  text: string;
  id?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

type ThinkingPartCtor = new (
  value: string | string[],
  id?: string,
  metadata?: Readonly<Record<string, unknown>>,
) => unknown;

interface AccumulatedToolCall {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

export class MiniMaxProvider implements vscode.LanguageModelChatProvider {
  private readonly modelsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelsChangedEmitter.event;

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
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    void token;
    const optionsWithConfig = options as PrepareOptionsWithConfiguration;
    const supportsProviderConfiguration = Object.prototype.hasOwnProperty.call(
      optionsWithConfig,
      "configuration",
    );
    if (!supportsProviderConfiguration) {
      return [];
    }

    const configuredApiKey = this.extractConfiguredApiKey(optionsWithConfig);
    if (!configuredApiKey) {
      return [];
    }
    return this.modelsWithApiKey(configuredApiKey);
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const modelApiKey = (model as ModelWithApiKey).__minimaxApiKey;
    const apiKey =
      modelApiKey && modelApiKey.trim().length > 0
        ? modelApiKey
        : await this.authManager.getOrPromptApiKey();

    if (!apiKey) {
      throw new Error('API key not configured. Use "MiniMax: Set API Key" command.');
    }

    try {
      await this.streamResponse(this.apiClient, model, messages, options, progress, token, apiKey);
    } catch (error) {
      await this.throwMappedError(error);
    }
  }

  private async streamResponse(
    client: MiniMaxClient,
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    apiKey: string,
  ): Promise<void> {
    const resolvedModel = getModelById(model.id);
    if (!resolvedModel) {
      throw new Error(`Unsupported model "${model.id}" selected for MiniMax Coding Plan.`);
    }

    let reasoningBuffer = "";
    const thinkingPartCtor = this.getThinkingPartCtor();
    const useReasoningSplit = Boolean(thinkingPartCtor);
    const pendingToolCalls = new Map<number, AccumulatedToolCall>();
    let toolCallsEmitted = false;
    const tools = this.convertTools(options.tools);

    const stream = client.streamChat(
      resolvedModel.id,
      this.convertMessages(messages),
      {
        maxTokens: this.resolveMaxTokens(options),
        temperature: DEFAULT_TEMPERATURE,
        apiKey,
        tools,
        toolChoice: this.resolveToolChoice(options, tools),
        reasoningSplit: useReasoningSplit,
      },
      token,
    );

    for await (const chunk of stream) {
      if (token.isCancellationRequested) {
        return;
      }

      for (const choice of chunk.choices) {
        if (thinkingPartCtor) {
          const latestReasoning = this.getLatestReasoningUpdate(choice);
          if (latestReasoning) {
            const newReasoning = latestReasoning.text.startsWith(reasoningBuffer)
              ? latestReasoning.text.slice(reasoningBuffer.length)
              : latestReasoning.text;

            if (newReasoning) {
              this.reportReasoning(progress, thinkingPartCtor, newReasoning, latestReasoning);
              reasoningBuffer = latestReasoning.text;
            }
          }
        }

        const content = choice.delta?.content;
        if (content) {
          progress.report(new vscode.LanguageModelTextPart(content));
        }

        this.accumulateToolCalls(choice, pendingToolCalls);
        if (!toolCallsEmitted && this.isToolCallFinish(choice)) {
          this.reportToolCalls(progress, pendingToolCalls);
          toolCallsEmitted = true;
        }
      }
    }
  }

  private async throwMappedError(error: unknown): Promise<never> {
    if (!(error instanceof MiniMaxError)) {
      throw error;
    }

    if (error.statusCode === 401) {
      await this.authManager.deleteApiKey();
      throw new Error('Invalid API key. Please set a new one using "MiniMax: Set API Key".');
    } else if (error.statusCode === 429) {
      throw new Error("Rate limit exceeded. Please wait and try again.");
    } else {
      throw new Error(`MiniMax API error: ${error.message}`);
    }
  }

  provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken,
  ): Thenable<number> {
    void model;
    void token;
    if (typeof text === "string") {
      return Promise.resolve(this.tokenCounter.estimateTokens(text));
    }

    let totalChars = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        totalChars += part.value.length;
      }
    }
    return Promise.resolve(this.tokenCounter.estimateTokens(String(totalChars)));
  }

  private convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
  ): MiniMaxMessage[] {
    const converted: MiniMaxMessage[] = [];
    for (const message of messages) {
      converted.push(...this.toMiniMaxMessages(message));
    }
    return converted;
  }

  private toMiniMaxMessages(message: vscode.LanguageModelChatRequestMessage): MiniMaxMessage[] {
    const role = this.convertRole(message.role);
    const parts = this.getMessageParts(message);

    if (role === "assistant") {
      return [this.toMiniMaxAssistantMessage(parts)];
    }

    if (role === "user") {
      return this.toMiniMaxUserAndToolMessages(parts);
    }

    return [
      {
        role: "system",
        content: this.concatTextParts(parts),
      },
    ];
  }

  private convertRole(role: vscode.LanguageModelChatMessageRole): "system" | "user" | "assistant" {
    switch (role) {
      case vscode.LanguageModelChatMessageRole.Assistant:
        return "assistant";
      case vscode.LanguageModelChatMessageRole.User:
        return "user";
      default:
        return "system";
    }
  }

  private getMessageParts(message: vscode.LanguageModelChatRequestMessage): readonly unknown[] {
    if (Array.isArray(message.content)) {
      return message.content as readonly unknown[];
    }

    if (typeof message.content === "string") {
      return [new vscode.LanguageModelTextPart(message.content)];
    }

    return [];
  }

  private toMiniMaxAssistantMessage(parts: readonly unknown[]): MiniMaxAssistantMessage {
    const content = this.concatTextParts(parts);
    const toolCalls: MiniMaxToolCall[] = [];
    const reasoningDetails: MiniMaxReasoningDetail[] = [];

    for (const part of parts) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: "function",
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        });
        continue;
      }

      const detail = this.toReasoningDetail(part, reasoningDetails.length);
      if (detail) {
        reasoningDetails.push(detail);
      }
    }

    return {
      role: "assistant",
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
    };
  }

  private toMiniMaxUserAndToolMessages(parts: readonly unknown[]): MiniMaxMessage[] {
    const textContent = this.concatTextParts(parts);
    const toolMessages: MiniMaxToolMessage[] = [];

    for (const part of parts) {
      if (part instanceof vscode.LanguageModelToolResultPart) {
        toolMessages.push({
          role: "tool",
          tool_call_id: part.callId,
          content: this.concatToolResultContent(part.content),
        });
      }
    }

    const messages: MiniMaxMessage[] = [];
    if (textContent.trim().length > 0 || toolMessages.length === 0) {
      messages.push({
        role: "user",
        content: textContent,
      });
    }
    messages.push(...toolMessages);
    return messages;
  }

  private concatTextParts(parts: readonly unknown[]): string {
    let text = "";
    for (const part of parts) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      }
    }
    return text;
  }

  private concatToolResultContent(parts: readonly unknown[]): string {
    let text = "";
    for (const part of parts) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelDataPart) {
        text += `[data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}]`;
      } else if (
        part &&
        typeof part === "object" &&
        "value" in part &&
        typeof (part as { value?: unknown }).value === "string"
      ) {
        text += (part as { value: string }).value;
      } else {
        text += this.safeJson(part);
      }
    }

    const normalized = text.trim();
    return normalized.length > 0 ? normalized : "{}";
  }

  private toReasoningDetail(part: unknown, index: number): MiniMaxReasoningDetail | undefined {
    if (!this.isThinkingPart(part)) {
      return undefined;
    }

    const value = part.value;
    const text = Array.isArray(value) ? value.join("") : value;
    if (!text || text.trim().length === 0) {
      return undefined;
    }

    const detail: MiniMaxReasoningDetail = {
      type: "reasoning.text",
      index,
      text,
    };

    const id = this.readNonEmptyString(part.id);
    if (id) {
      detail.id = id;
    }

    const format = this.readNonEmptyString(part.format);
    if (format) {
      detail.format = format;
    }

    const metadata = part.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      Object.assign(detail, metadata as Record<string, unknown>);
    }

    return detail;
  }

  private isThinkingPart(
    value: unknown,
  ): value is { value: string | string[]; id?: unknown; format?: unknown; metadata?: unknown } {
    if (!value || typeof value !== "object") {
      return false;
    }
    if (value instanceof vscode.LanguageModelTextPart) {
      return false;
    }
    if (value instanceof vscode.LanguageModelToolCallPart) {
      return false;
    }
    if (value instanceof vscode.LanguageModelToolResultPart) {
      return false;
    }
    if (value instanceof vscode.LanguageModelDataPart) {
      return false;
    }

    const candidate = value as { value?: unknown };
    if (!(typeof candidate.value === "string" || Array.isArray(candidate.value))) {
      return false;
    }

    if (Array.isArray(candidate.value)) {
      return candidate.value.every((item) => typeof item === "string");
    }

    return true;
  }

  private extractConfiguredApiKey(options: PrepareOptionsWithConfiguration): string | undefined {
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

  private modelsWithApiKey(apiKey: string): vscode.LanguageModelChatInformation[] {
    const visibleModels = this.getVisibleModels();
    return visibleModels.map(
      (model) =>
        ({
          id: model.id,
          name: model.name,
          detail: "Coding Plan",
          family: model.id,
          version: "1.0",
          maxInputTokens: model.contextLength,
          maxOutputTokens: model.contextLength,
          capabilities: { toolCalling: true },
          __minimaxApiKey: apiKey,
        }) as ModelWithApiKey,
    );
  }

  private getVisibleModels() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const raw = config.get<unknown>(VISIBLE_MODELS_KEY);
    if (!Array.isArray(raw)) {
      return SUPPORTED_MODELS;
    }

    const configuredIds = new Set(
      raw.filter((value): value is string => typeof value === "string"),
    );
    const visibleModels = SUPPORTED_MODELS.filter((model) => configuredIds.has(model.id));
    return visibleModels.length > 0 ? visibleModels : SUPPORTED_MODELS;
  }

  private resolveMaxTokens(options: vscode.ProvideLanguageModelChatResponseOptions): number {
    const value = options.modelOptions?.maxTokens;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      return DEFAULT_MAX_TOKENS;
    }
    return value;
  }

  private getLatestReasoningUpdate(choice: { delta?: unknown }): ReasoningUpdate | undefined {
    const delta = choice.delta as { reasoning_details?: unknown } | undefined;
    const reasoningDetails = delta?.reasoning_details;
    if (!Array.isArray(reasoningDetails)) {
      return undefined;
    }

    let latest: ReasoningUpdate | undefined;
    for (const detail of reasoningDetails) {
      if (!detail || typeof detail !== "object") {
        continue;
      }

      const candidate = detail as Record<string, unknown>;
      if (typeof candidate.text !== "string") {
        continue;
      }

      const id =
        this.readNonEmptyString(candidate.id) ??
        this.readNonEmptyString(candidate.reasoning_id) ??
        this.readNonEmptyString(candidate.thinking_id);

      const metadata =
        candidate.metadata &&
        typeof candidate.metadata === "object" &&
        !Array.isArray(candidate.metadata)
          ? (candidate.metadata as Readonly<Record<string, unknown>>)
          : undefined;

      latest = {
        text: candidate.text,
        id,
        metadata,
      };
    }
    return latest;
  }

  private reportReasoning(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    thinkingPartCtor: ThinkingPartCtor | undefined,
    text: string,
    reasoning: ReasoningUpdate,
  ): void {
    if (!thinkingPartCtor) {
      progress.report(new vscode.LanguageModelTextPart(`<think>${text}</think>`));
      return;
    }

    const thinkingPart = new thinkingPartCtor(text, reasoning.id, reasoning.metadata);
    (progress as vscode.Progress<vscode.LanguageModelResponsePart | unknown>).report(
      thinkingPart as vscode.LanguageModelResponsePart,
    );
  }

  private getThinkingPartCtor(): ThinkingPartCtor | undefined {
    const vscodeWithThinking = vscode as unknown as {
      LanguageModelThinkingPart?: ThinkingPartCtor;
    };
    return typeof vscodeWithThinking.LanguageModelThinkingPart === "function"
      ? vscodeWithThinking.LanguageModelThinkingPart
      : undefined;
  }

  private readNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
  ): MiniMaxToolDefinition[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    const converted: MiniMaxToolDefinition[] = [];
    for (const tool of tools) {
      const name = this.normalizeToolName(tool.name);
      if (!name) {
        continue;
      }

      converted.push({
        type: "function",
        function: {
          name,
          description: this.normalizeToolDescription(tool.description),
          parameters: this.normalizeToolParameters(tool.inputSchema),
        },
      });
    }

    return converted.length > 0 ? converted : undefined;
  }

  private resolveToolChoice(
    options: vscode.ProvideLanguageModelChatResponseOptions,
    tools: readonly MiniMaxToolDefinition[] | undefined,
  ): "auto" | "required" | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    return options.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
  }

  private normalizeToolName(name: string | undefined): string | undefined {
    if (typeof name !== "string") {
      return undefined;
    }
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeToolDescription(description: string | undefined): string | undefined {
    if (typeof description !== "string") {
      return undefined;
    }
    const trimmed = description.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizeToolParameters(inputSchema: unknown): Record<string, unknown> {
    const fallback: Record<string, unknown> = {
      type: "object",
      properties: {},
    };

    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
      return fallback;
    }

    const schema = { ...(inputSchema as Record<string, unknown>) };
    if (!("type" in schema)) {
      schema.type = "object";
    }

    if (schema.type === "object" && !("properties" in schema)) {
      schema.properties = {};
    }

    return schema;
  }

  private accumulateToolCalls(
    choice: { delta?: unknown },
    pending: Map<number, AccumulatedToolCall>,
  ): void {
    const delta = choice.delta as { tool_calls?: unknown } | undefined;
    if (!Array.isArray(delta?.tool_calls)) {
      return;
    }

    for (const rawCall of delta.tool_calls) {
      if (!rawCall || typeof rawCall !== "object") {
        continue;
      }

      const call = rawCall as {
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const index =
        typeof call.index === "number" && Number.isInteger(call.index) && call.index >= 0
          ? call.index
          : pending.size;
      const current = pending.get(index) ?? { index, arguments: "" };

      if (typeof call.id === "string" && call.id.length > 0) {
        current.id = call.id;
      }
      if (typeof call.function?.name === "string" && call.function.name.length > 0) {
        current.name = call.function.name;
      }
      if (typeof call.function?.arguments === "string" && call.function.arguments.length > 0) {
        current.arguments += call.function.arguments;
      }

      pending.set(index, current);
    }
  }

  private isToolCallFinish(choice: { finish_reason?: unknown }): boolean {
    return choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call";
  }

  private reportToolCalls(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    pending: Map<number, AccumulatedToolCall>,
  ): void {
    const orderedCalls = [...pending.values()].sort((a, b) => a.index - b.index);
    for (const call of orderedCalls) {
      if (!call.id || !call.name) {
        continue;
      }

      progress.report(
        new vscode.LanguageModelToolCallPart(
          call.id,
          call.name,
          this.parseToolArguments(call.arguments),
        ),
      );
    }
  }

  private parseToolArguments(raw: string): object {
    const text = raw.trim();
    if (!text) {
      return {};
    }

    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as object;
      }
      return { value: parsed };
    } catch {
      return { rawArguments: raw };
    }
  }

  private safeJson(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
}
