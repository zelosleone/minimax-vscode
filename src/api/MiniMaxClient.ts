import * as vscode from "vscode";
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions/completions";
import { MiniMaxMessage, MiniMaxToolDefinition } from "./types";

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
  tools?: MiniMaxToolDefinition[];
  toolChoice?: "auto" | "required";
  reasoningSplit?: boolean;
}

export class MiniMaxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "MiniMaxError";
  }
}

export class MiniMaxClient {
  private readonly baseUrl = "https://api.minimax.io/v1";

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
      const client = new OpenAI({
        apiKey,
        baseURL: this.baseUrl,
      });

      const params: ChatCompletionCreateParamsStreaming = {
        model,
        stream: true,
        messages: this.toOpenAiMessages(messages),
        temperature: options?.temperature ?? 1,
        max_tokens: options?.maxTokens ?? 8192,
      };
      if (options?.tools && options.tools.length > 0) {
        (
          params as ChatCompletionCreateParamsStreaming & {
            tools?: MiniMaxToolDefinition[];
          }
        ).tools = options.tools;
      }
      if (options?.toolChoice) {
        (
          params as ChatCompletionCreateParamsStreaming & {
            tool_choice?: "auto" | "required";
          }
        ).tool_choice = options.toolChoice;
      }
      (
        params as ChatCompletionCreateParamsStreaming & {
          extra_body?: { reasoning_split?: boolean };
        }
      ).extra_body = { reasoning_split: options?.reasoningSplit ?? true };

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
      throw this.toMiniMaxError(error);
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
        } as unknown as ChatCompletionMessageParam;
      }

      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.tool_call_id,
          content: message.content,
        } as unknown as ChatCompletionMessageParam;
      }

      return {
        role: message.role,
        content: message.content,
      } as ChatCompletionMessageParam;
    });
  }

  private toMiniMaxError(error: unknown): MiniMaxError {
    if (error instanceof OpenAI.APIError) {
      const statusCode = error.status ?? 0;
      const code = statusCode === 401 ? "AUTHENTICATION_ERROR" : "API_ERROR";
      return new MiniMaxError(error.message, code, statusCode);
    }

    if (error instanceof Error && error.name === "AbortError") {
      return new MiniMaxError("Request timeout", "TIMEOUT");
    }

    if (error instanceof Error) {
      return new MiniMaxError(error.message, "NETWORK_ERROR");
    }

    return new MiniMaxError(String(error), "UNKNOWN_ERROR");
  }
}
