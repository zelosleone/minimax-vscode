import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionAssistantMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
  ChatCompletionSystemMessageParam,
} from "openai/resources/chat/completions/completions";
import type { MiniMaxMessage, MiniMaxReasoningDetail, MiniMaxToolDefinition } from "./types";
import { MiniMaxError } from "./MiniMaxError";
import { toMiniMaxError } from "./MiniMaxErrorMapper";
import type { MinimaxStreamClient, NormalizedStreamEvent, ProviderChatOptions } from "./MinimaxStreamClient";

/**
 * MiniMax extensions to the OpenAI assistant message shape.
 * `reasoning_details` is a MiniMax-specific field not modelled by the OpenAI SDK.
 */
type AssistantMessageWithReasoning = Omit<ChatCompletionAssistantMessageParam, "content"> & {
  content: ChatCompletionAssistantMessageParam["content"];
  reasoning_details?: readonly MiniMaxReasoningDetail[];
};

interface ChatChoiceDelta {
  content?: string | null;
  reasoning_content?: string;
  reasoning_details?: readonly { text?: string; signature?: string }[];
  tool_calls?: readonly {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

export { MiniMaxError };

const DEFAULT_OPENAI_BASE_URL = "https://api.minimax.io/v1";

export class MiniMaxOpenAIClient implements MinimaxStreamClient {
  readonly provider = "openai-compat" as const;

  constructor(private readonly baseUrl?: string) {}

  async *streamChat(options: ProviderChatOptions): AsyncGenerator<NormalizedStreamEvent> {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new MiniMaxError("API key is required", "NO_API_KEY", 401);
    }

    const abortController = new AbortController();
    const disposable = options.cancellationToken?.onCancellationRequested(() =>
      abortController.abort(),
    );

    try {
      const baseUrl = this.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL;
      const client = new OpenAI({ apiKey, baseURL: baseUrl });

      const params: ChatCompletionCreateParamsStreaming = {
        model: options.model,
        stream: true,
        messages: this.toOpenAiMessages(options.messages),
        temperature: options.temperature,
        max_tokens: options.maxTokens,
      };
      if (typeof options.topP === "number" && options.topP > 0 && options.topP <= 1) {
        (params as ChatCompletionCreateParamsStreaming & { top_p?: number }).top_p = options.topP;
      }
      if (options.tools && options.tools.length > 0) {
        (params as ChatCompletionCreateParamsStreaming & { tools?: MiniMaxToolDefinition[] }).tools =
          options.tools;
      }
      if (options.toolChoice) {
        // OpenAI SDK's tool_choice enum is "auto" | "required" | "none" — matches our setting.
        if (options.toolChoice !== "none") {
          (params as ChatCompletionCreateParamsStreaming & { tool_choice?: "auto" | "required" }).tool_choice =
            options.toolChoice;
        }
      }
      // Explicitly send the thinking mode so behavior matches the Anthropic
      // adapter regardless of endpoint defaults. When options.thinking is
      // undefined ("auto" mode) we omit the `thinking` key but keep
      // reasoning_split=true so any thinking the model emits is still
      // surfaced as a structured reasoning_content / reasoning_details field.
      (params as ChatCompletionCreateParamsStreaming & {
        extra_body?: { reasoning_split?: boolean; thinking?: { type: "disabled" | "adaptive" } };
      }).extra_body = {
        reasoning_split: options.reasoningSplit ?? true,
        ...(options.thinking ? { thinking: options.thinking } : {}),
      };
      params.stream_options = { include_usage: true };
      if (options.serviceTier && options.serviceTier === "priority") {
        (params as ChatCompletionCreateParamsStreaming & { service_tier?: string }).service_tier =
          "priority";
      }

      const stream = (await client.chat.completions.create(params, {
        signal: abortController.signal,
      })) as AsyncIterable<ChatCompletionChunk>;

      for await (const chunk of stream) {
        if (options.cancellationToken?.isCancellationRequested) {
          return;
        }
        for (const event of this.fromOpenAIChunk(chunk)) {
          yield event;
        }
      }
    } catch (error) {
      throw toMiniMaxError(error);
    } finally {
      disposable?.dispose();
    }
  }

  private *fromOpenAIChunk(chunk: ChatCompletionChunk): Generator<NormalizedStreamEvent> {
    // Usage (final chunk with stream_options.include_usage).
    const usage = chunk.usage;
    if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
      yield {
        kind: "usage",
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
      };
    }

    for (const choice of chunk.choices) {
      const delta = choice.delta as ChatChoiceDelta;

      // Reasoning content (M3 streaming with reasoning_split=true).
      if (delta.reasoning_content) {
        yield { kind: "thinking", text: delta.reasoning_content };
      }

      // Reasoning details (alternative stream field on some models).
      if (Array.isArray(delta.reasoning_details)) {
        for (const detail of delta.reasoning_details) {
          if (typeof detail.text === "string") {
            yield {
              kind: "thinking",
              text: detail.text,
              ...(typeof detail.signature === "string" ? { signature: detail.signature } : {}),
            };
          }
        }
      }

      // Text content (may contain inline <think>...</think> tags).
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { kind: "text", text: delta.content };
      }

      // Tool calls.
      if (Array.isArray(delta.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          const index = typeof rawCall.index === "number" ? rawCall.index : 0;
          if (typeof rawCall.id === "string" && rawCall.id.length > 0 && typeof rawCall.function?.name === "string") {
            yield {
              kind: "tool_use_start",
              index,
              id: rawCall.id,
              name: rawCall.function.name,
            };
          }
          if (typeof rawCall.function?.arguments === "string" && rawCall.function.arguments.length > 0) {
            yield { kind: "tool_use_delta", index, partialJson: rawCall.function.arguments };
          }
        }
      }

      if (choice.finish_reason) {
        yield { kind: "finish", stopReason: choice.finish_reason };
      }
    }
  }

  private toOpenAiMessages(messages: MiniMaxMessage[]): ChatCompletionMessageParam[] {
    return messages.map((message): ChatCompletionMessageParam => {
      if (message.role === "assistant") {
        const base: AssistantMessageWithReasoning = {
          role: "assistant",
          content: toAssistantContent(message.content),
          tool_calls: message.tool_calls,
          ...(message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}),
          ...(message.name ? { name: message.name } : {}),
        };
        return base as ChatCompletionMessageParam;
      }
      if (message.role === "tool") {
        const toolMsg: ChatCompletionToolMessageParam = {
          role: "tool",
          tool_call_id: message.tool_call_id,
          content: toTextOnlyContent(message.content),
        };
        return toolMsg;
      }
      if (message.role === "user") {
        const userMsg: ChatCompletionUserMessageParam = {
          role: "user",
          content: toUserContent(message.content),
          ...(message.name ? { name: message.name } : {}),
        };
        return userMsg;
      }
      const sysMsg: ChatCompletionSystemMessageParam = {
        role: "system",
        content: toTextOnlyContent(message.content),
        ...(message.name ? { name: message.name } : {}),
      };
      return sysMsg;
    });
  }
}

type OpenAITextOnlyContentPart =
  import("openai/resources/chat/completions/completions").ChatCompletionContentPartText;
type OpenAIAssistantContentPart =
  | import("openai/resources/chat/completions/completions").ChatCompletionContentPartText
  | import("openai/resources/chat/completions/completions").ChatCompletionContentPartRefusal;
type OpenAIUserContentPart =
  | import("openai/resources/chat/completions/completions").ChatCompletionContentPartText
  | import("openai/resources/chat/completions/completions").ChatCompletionContentPartImage;

/**
 * Convert `MiniMaxChatContent` into the assistant content type accepted by
 * the OpenAI SDK (`string` or an array of text/refusal parts). Image
 * references in MiniMax user content are filtered out (they belong in user
 * messages, not assistant ones).
 */
function toAssistantContent(content: import("./types").MiniMaxChatContent): string | OpenAIAssistantContentPart[] {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => ({ type: "text" as const, text: p.text }));
}

/**
 * Convert to the text-only content type used by tool and system messages.
 */
function toTextOnlyContent(content: import("./types").MiniMaxChatContent): string | OpenAITextOnlyContentPart[] {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => ({ type: "text" as const, text: p.text }));
}

/**
 * Convert to the user content type (text + image parts).
 */
function toUserContent(content: import("./types").MiniMaxChatContent): string | OpenAIUserContentPart[] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((p) => {
    if (p.type === "text") {
      return { type: "text" as const, text: p.text };
    }
    return { type: "image_url" as const, image_url: { url: p.image_url.url } };
  });
}
