import * as vscode from "vscode";
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";
import type { MiniMaxMessage, MiniMaxToolDefinition } from "./types";
import { MiniMaxError } from "./MiniMaxError";
import { toMiniMaxError } from "./MiniMaxErrorMapper";

export { MiniMaxError };

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  /** Sent as max_tokens only when defined (Copilot-passed, capped by the caller). */
  maxTokens?: number;
  apiKey?: string;
  baseUrl?: string;
  tools?: MiniMaxToolDefinition[];
  toolChoice?: "auto" | "required";
  reasoningSplit?: boolean;
  /** MiniMax OpenAI-compatible reasoning fields: thinking + reasoning_effort. */
  reasoningFields?: Record<string, unknown>;
}

export class MiniMaxClient {
  private readonly defaultBaseUrl = "https://api.minimax.io/v1";

  async *streamChat(
    model: string,
    messages: MiniMaxMessage[],
    options?: ChatOptions,
    cancellationToken?: vscode.CancellationToken,
  ): AsyncGenerator<ChatCompletionChunk> {
    const apiKey = options?.apiKey?.trim();
    if (!apiKey) {
      throw new MiniMaxError("API key is required", "NO_API_KEY", 401);
    }

    const abortController = new AbortController();
    const cancellationDisposable = cancellationToken?.onCancellationRequested(() =>
      abortController.abort(),
    );

    try {
      const baseUrl = options?.baseUrl?.trim() || this.defaultBaseUrl;
      const client = new OpenAI({ apiKey, baseURL: baseUrl });

      const params: ChatCompletionCreateParamsStreaming = {
        model,
        stream: true,
        messages: this.toOpenAiMessages(messages),
        temperature: options?.temperature ?? 1,
      };
      if (typeof options?.maxTokens === "number" && options.maxTokens > 0) {
        params.max_tokens = Math.floor(options.maxTokens);
      }
      if (options?.reasoningFields) {
        Object.assign(params, options.reasoningFields);
      }
      if (typeof options?.topP === "number" && options.topP > 0 && options.topP <= 1) {
        (params as ChatCompletionCreateParamsStreaming & { top_p?: number }).top_p = options.topP;
      }
      if (options?.tools && options.tools.length > 0) {
        (params as ChatCompletionCreateParamsStreaming & { tools?: MiniMaxToolDefinition[] }).tools =
          options.tools;
      }
      if (options?.toolChoice) {
        (params as ChatCompletionCreateParamsStreaming & { tool_choice?: "auto" | "required" }).tool_choice =
          options.toolChoice;
      }
      // A top-level body field: Python's extra_body is flattened into the body, the Node SDK sends it as-is.
      (params as ChatCompletionCreateParamsStreaming & { reasoning_split?: boolean }).reasoning_split =
        options?.reasoningSplit ?? true;
      params.stream_options = { include_usage: true };

      const stream = (await client.chat.completions.create(params, {
        signal: abortController.signal,
      })) as AsyncIterable<ChatCompletionChunk>;

      for await (const chunk of stream) {
        if (cancellationToken?.isCancellationRequested) {
          return;
        }
        yield chunk;
      }
    } catch (error) {
      throw toMiniMaxError(error);
    } finally {
      cancellationDisposable?.dispose();
    }
  }

  private toOpenAiMessages(messages: MiniMaxMessage[]): ChatCompletionMessageParam[] {
    return messages.map((message) => {
      if (message.role === "assistant") {
        return {
          role: "assistant",
          content: message.content,
          tool_calls: message.tool_calls,
          reasoning_details: message.reasoning_details,
          ...(message.name ? { name: message.name } : {}),
        } as unknown as ChatCompletionMessageParam;
      }
      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.tool_call_id,
          content: message.content,
        } as unknown as ChatCompletionMessageParam;
      }
      if (message.role === "user") {
        return {
          role: "user",
          content: message.content,
          ...(message.name ? { name: message.name } : {}),
        } as unknown as ChatCompletionMessageParam;
      }
      return {
        role: "system",
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
      } as ChatCompletionMessageParam;
    });
  }
}
