import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageStreamEvent,
  MessageCreateParamsStreaming,
  MessageCountTokensParams,
  Tool,
  ToolUseBlock,
  ToolResultBlockParam,
  TextBlockParam,
  ImageBlockParam,
  ThinkingBlockParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { MiniMaxMessage, MiniMaxToolDefinition } from "./types";
import { MiniMaxError } from "./MiniMaxError";
import { toMiniMaxError } from "./MiniMaxErrorMapper";
import type { MinimaxStreamClient, NormalizedStreamEvent, ProviderChatOptions } from "./MinimaxStreamClient";

export { MiniMaxError };

/**
 * MiniMax's documented `service_tier` values for streaming requests.
 * (Anthropic's typed streaming field only models "auto" | "standard_only".)
 */
type MiniMaxServiceTier = "standard" | "priority";

/**
 * Anthropic streaming request params with MiniMax's `service_tier` enum
 * overlaid, replacing the upstream enum. Use this for any value we send on
 * the wire rather than the SDK's `MessageCreateParamsStreaming`.
 */
type AnthropicMessageParams = Omit<MessageCreateParamsStreaming, "service_tier"> & {
  service_tier?: MiniMaxServiceTier;
};

/**
 * MiniMax's `thinking` values. The Anthropic SDK only types
 * `{type: "enabled", budget_tokens}` | `{type: "disabled"}`, but MiniMax
 * documents `{"type": "adaptive"}` to enable thinking (no budget_tokens) and
 * `{"type": "disabled"}` to turn it off. On this endpoint M3's thinking is OFF
 * by default, so "adaptive" must be sent explicitly when the user wants it.
 */
type MiniMaxThinking = { type: "adaptive" } | { type: "disabled" };

const ANTHROPIC_MEDIA_TYPE_TO_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

export class MiniMaxAnthropicClient implements MinimaxStreamClient {
  readonly provider = "anthropic-compat" as const;

  constructor(private readonly baseUrl: string) {}

  async *streamChat(options: ProviderChatOptions): AsyncGenerator<NormalizedStreamEvent> {
    const abortController = new AbortController();
    const disposable = options.cancellationToken?.onCancellationRequested(() =>
      abortController.abort(),
    );

    try {
      const client = new Anthropic({
        apiKey: options.apiKey,
        baseURL: this.baseUrl,
        maxRetries: 0,
        timeout: 600_000,
      });

      const params: MessageCreateParamsStreaming = {
        model: options.model,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        messages: toAnthropicMessages(options.messages),
        stream: true,
      };
      if (options.systemPrompt) {
        params.system = options.systemPrompt;
      }
      if (typeof options.topP === "number" && options.topP > 0 && options.topP <= 1) {
        params.top_p = options.topP;
      }
      if (options.tools && options.tools.length > 0) {
        params.tools = toAnthropicTools(options.tools);
      }
      if (options.toolChoice) {
        // Anthropic tool_choice is an object like { type: "auto" | "any" | "tool", name?: string }.
        // We map our "auto" / "required" / "none" to "auto" / "any" / "none".
        if (options.toolChoice === "required") {
          params.tool_choice = { type: "any" };
        } else {
          params.tool_choice = { type: options.toolChoice };
        }
      }
      // Thinking control — when options.thinking is undefined ("auto" mode)
      // we omit the field so the endpoint default applies (Anthropic: off for
      // M3, on for M2.x). When it's an explicit object we send it as-is.
      if (options.thinking) {
        (params as AnthropicMessageParams & { thinking?: MiniMaxThinking }).thinking =
          options.thinking;
      }
      if (options.serviceTier) {
        // Anthropic's typed streaming `service_tier` enum is "auto" | "standard_only",
        // but MiniMax documents `service_tier: "standard" | "priority"`. Cast the
        // params to a local type with the MiniMax enum, so the value is type-checked
        // without an `as unknown` escape hatch.
        (params as AnthropicMessageParams).service_tier = options.serviceTier;
      }

      const stream = client.messages.stream(params, {
        signal: abortController.signal,
      });

      // Track each content block's type so content_block_stop can be mapped
      // to tool_use_stop only for tool_use blocks.
      const blockTypes = new Map<number, "text" | "thinking" | "tool_use">();
      for await (const event of stream) {
        if (options.cancellationToken?.isCancellationRequested) {
          return;
        }
        for (const normalized of fromAnthropicEvent(event, blockTypes)) {
          yield normalized;
        }
      }
    } catch (error) {
      throw toMiniMaxError(error);
    } finally {
      disposable?.dispose();
    }
  }

  async countInputTokens(
    options: ProviderChatOptions,
  ): Promise<{ inputTokens: number } | undefined> {
    try {
      const client = new Anthropic({
        apiKey: options.apiKey,
        baseURL: this.baseUrl,
        maxRetries: 0,
        timeout: 60_000,
      });
      const params: MessageCountTokensParams = {
        model: options.model,
        messages: toAnthropicMessages(options.messages),
      };
      if (options.systemPrompt) {
        params.system = options.systemPrompt;
      }
      if (options.tools && options.tools.length > 0) {
        params.tools = toAnthropicTools(options.tools);
      }
      const result = await client.messages.countTokens(params);
      return { inputTokens: result.input_tokens };
    } catch {
      return undefined;
    }
  }
}

function fromAnthropicEvent(
  event: MessageStreamEvent,
  blockTypes: Map<number, "text" | "thinking" | "tool_use">,
): NormalizedStreamEvent[] {
  switch (event.type) {
    case "content_block_start": {
      const block = event.content_block;
      const blockType =
        block.type === "text"
          ? "text"
          : block.type === "thinking"
            ? "thinking"
            : block.type === "tool_use"
              ? "tool_use"
              : "text";
      blockTypes.set(event.index, blockType);
      const out: NormalizedStreamEvent[] = [
        {
          kind: "content_block_start",
          index: event.index,
          blockType,
        },
      ];
      if (block.type === "tool_use") {
        out.push({
          kind: "tool_use_start",
          index: event.index,
          id: block.id,
          name: block.name,
        });
      }
      return out;
    }
    // No-op events in the message stream. We just pass them through.
    case "message_start": {
      return [];
    }
    case "content_block_delta": {
      const delta = event.delta;
      if (delta.type === "text_delta") {
        return [{ kind: "text", text: delta.text }];
      }
      if (delta.type === "thinking_delta") {
        return [{ kind: "thinking", text: delta.thinking }];
      }
      if (delta.type === "input_json_delta") {
        return [
          { kind: "tool_use_delta", index: event.index, partialJson: delta.partial_json },
        ];
      }
      if (delta.type === "signature_delta") {
        return [{ kind: "thinking", text: "", signature: delta.signature }];
      }
      return [];
    }
    case "content_block_stop":
      if (blockTypes.get(event.index) === "tool_use") {
        return [{ kind: "tool_use_stop", index: event.index }];
      }
      return [];
    case "message_delta": {
      const usage = (event as { usage?: { input_tokens?: number; output_tokens?: number } })
        .usage;
      const out: NormalizedStreamEvent[] = [
        {
          kind: "finish",
          stopReason: (event.delta as { stop_reason?: string })?.stop_reason ?? "end_turn",
        },
      ];
      if (usage) {
        out.unshift({
          kind: "usage",
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
        });
      }
      return out;
    }
    case "message_stop":
      return [{ kind: "finish", stopReason: "end_turn" }];
    default:
      return [];
  }
}

function toAnthropicTools(tools: readonly MiniMaxToolDefinition[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: (tool.function.parameters ?? { type: "object", properties: {} }) as Tool["input_schema"],
  }));
}

function toAnthropicMessages(
  messages: readonly MiniMaxMessage[],
): { role: "user" | "assistant"; content: ContentBlockParam[] }[] {
  const out: { role: "user" | "assistant"; content: ContentBlockParam[] }[] = [];
  // The Messages API requires user/assistant roles to alternate, so instead
  // of pushing directly we merge consecutive same-role messages into one
  // (tool results become user-role messages and often neighbor user text).
  const push = (role: "user" | "assistant", blocks: ContentBlockParam[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
      return;
    }
    out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "system") {
      // System messages are handled separately via the `system` field, not in
      // the messages array. We never include them here.
      continue;
    }
    if (message.role === "user") {
      const blocks = userContentToBlocks(message.content);
      if (blocks.length > 0) {
        push("user", blocks);
      }
    } else if (message.role === "assistant") {
      const blocks: ContentBlockParam[] = [];
      const text = typeof message.content === "string" ? message.content : "";
      if (text.length > 0) {
        blocks.push({ type: "text", text } as TextBlockParam);
      }
      if (message.tool_calls) {
        for (const call of message.tool_calls) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(call.function.arguments);
          } catch {
            input = {};
          }
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input,
          } as ToolUseBlock);
        }
      }
      if (message.reasoning_details) {
        for (const detail of message.reasoning_details) {
          if (typeof detail.text !== "string") {
            continue;
          }
          if (typeof detail.signature === "string" && detail.signature.length > 0) {
            const tb: ThinkingBlockParam = {
              type: "thinking",
              thinking: detail.text,
              signature: detail.signature,
            };
            blocks.push(tb);
          }
          // If no signature is present we skip emitting the thinking block,
          // because Anthropic requires a signature to round-trip.
        }
      }
      if (blocks.length > 0) {
        push("assistant", blocks);
      }
    } else if (message.role === "tool") {
      const tr: ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content,
      };
      push("user", [tr]);
    }
  }
  // Within a user message, tool_result blocks must precede other content.
  for (const message of out) {
    if (message.role === "user" && message.content.some((b) => b.type === "tool_result")) {
      message.content = [
        ...message.content.filter((b) => b.type === "tool_result"),
        ...message.content.filter((b) => b.type !== "tool_result"),
      ];
    }
  }
  return out;
}

function userContentToBlocks(content: unknown): ContentBlockParam[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: ContentBlockParam[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const p = part as { type?: string; text?: string; image_url?: { url?: string } };
    if (p.type === "text" && typeof p.text === "string") {
      blocks.push({ type: "text", text: p.text });
    } else if (p.type === "image_url" && p.image_url?.url) {
      const block = dataUrlToImageBlock(p.image_url.url);
      if (block) {
        blocks.push(block);
      }
    }
  }
  return blocks;
}

function dataUrlToImageBlock(url: string): ImageBlockParam | undefined {
  const match = /^data:([^;]+);base64,(.+)$/.exec(url);
  if (!match) {
    return undefined;
  }
  const mediaType = match[1];
  const data = match[2];
  if (mediaType !== "image/jpeg" && mediaType !== "image/png" && mediaType !== "image/gif" && mediaType !== "image/webp") {
    return undefined;
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
      data,
    },
  };
}

export { ANTHROPIC_MEDIA_TYPE_TO_MIME };
