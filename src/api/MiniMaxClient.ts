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
  topP?: number;
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
      if (typeof options?.topP === "number" && options.topP > 0 && options.topP <= 1) {
        // MiniMax supports top_p but the streaming SDK type omits it.
        (params as ChatCompletionCreateParamsStreaming & { top_p?: number }).top_p = options.topP;
      }
      if (options?.tools && options.tools.length > 0) {
        // tools and tool_choice are supported by MiniMax but not on the streaming type.
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

      // create() returns Stream<...> — AsyncIterable at runtime, but the
      // streaming overload doesn't narrow to it.
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
    // MiniMax extends the OpenAI schema with tool_calls, reasoning_details, and
    // name on assistant/system messages. The SDK type union doesn't include them.
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

  private toMiniMaxError(error: unknown): MiniMaxError {
    if (error instanceof OpenAI.APIError) {
      const statusCode = error.status ?? 0;
      const minimaxCode = this.extractMiniMaxCode(error);
      const message = this.resolveMiniMaxErrorMessage(minimaxCode, error.message, statusCode);
      const code = minimaxCode ?? (statusCode === 401 ? "AUTHENTICATION_ERROR" : "API_ERROR");
      return new MiniMaxError(message, code, statusCode);
    }

    if (error instanceof Error && error.name === "AbortError") {
      return new MiniMaxError("Request timeout", "TIMEOUT");
    }

    if (error instanceof Error) {
      return new MiniMaxError(error.message, "NETWORK_ERROR");
    }

    return new MiniMaxError(String(error), "UNKNOWN_ERROR");
  }

  private extractMiniMaxCode(error: unknown): string | undefined {
    // Check both `code` at top level and `error.code` nested in the body.
    const code = (error as { code?: string | null }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }

    const rawError = (error as { error?: Record<string, unknown> }).error;
    if (rawError && typeof rawError === "object") {
      const bodyCode = rawError.code;
      if (typeof bodyCode === "string" && bodyCode.length > 0) {
        return bodyCode;
      }
      const bodyStatus = rawError.status;
      if (typeof bodyStatus === "string" && bodyStatus.length > 0) {
        return bodyStatus;
      }
    }

    return undefined;
  }

  private resolveMiniMaxErrorMessage(
    minimaxCode: string | undefined,
    fallbackMessage: string,
    statusCode: number,
  ): string {
    switch (minimaxCode) {
      case "1000":
        return "Unknown error. Please try again later.";
      case "1001":
        return "Request timed out. Please try again.";
      case "1002":
        return "Rate limit exceeded. Please wait a moment and try again.";
      case "1004":
        return "Invalid API key or unauthorized request.";
      case "1008":
        return "Insufficient balance. Please check your MiniMax Token Plan.";
      case "1024":
        return "Internal server error. Please try again later.";
      case "1026":
        return "Input flagged by content safety system. Please adjust your prompt.";
      case "1027":
        return "Output flagged by content safety system. Please adjust your prompt.";
      case "1033":
        return "Internal system error. Please try again later.";
      case "1039":
        return "Token limit exceeded. Please reduce the message length and try again.";
      case "1041":
        return "Connection limit reached. Please wait and try again.";
      case "1042":
        return "Input contains excessive invisible characters. Please clean up your input.";
      case "2049":
        return "Invalid API key. Please check your key and try again.";
      default:
        if (statusCode === 429) {
          return "Rate limit exceeded. Please wait and try again.";
        }
        if (statusCode === 401) {
          return "Invalid API key. Please set a new one.";
        }
        return fallbackMessage;
    }
  }
}
