import type * as vscode from "vscode";

/**
 * Provider-agnostic normalized stream event. Both the OpenAI-compat and
 * Anthropic-compat adapters map their native stream events into this union
 * so `MiniMaxProvider.streamResponse()` can be a single switch.
 */
export type NormalizedStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; signature?: string }
  | { kind: "tool_use_start"; index: number; id: string; name: string }
  | { kind: "tool_use_delta"; index: number; partialJson: string }
  | { kind: "tool_use_stop"; index: number }
  | { kind: "content_block_start"; index: number; blockType: "text" | "thinking" | "tool_use" }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number }
  | { kind: "finish"; stopReason: string };

/**
 * Provider-agnostic options for a chat completion request.
 */
export interface ProviderChatOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  topP?: number;
  tools?: import("./types").MiniMaxToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
  reasoningSplit?: boolean;
  /**
   * Wire-format thinking control:
   * - `{ type: "adaptive" }` — always send `thinking: {"type":"adaptive"}`.
   * - `{ type: "disabled" }` — always send `thinking: {"type":"disabled"}`.
   * - `undefined` — omit the field entirely (let the endpoint / model default
   *   take effect; this is what "auto" mode resolves to).
   */
  thinking?: { type: "adaptive" } | { type: "disabled" };
  serviceTier?: "standard" | "priority";
  cancellationToken?: vscode.CancellationToken;
  // Provider-specific message format. Adapters are responsible for translating
  // this into their own wire format.
  messages: import("./types").MiniMaxMessage[];
  // The system prompt, if any. Already separated out of the messages array.
  systemPrompt?: string;
}

/**
 * The common contract every chat-completions adapter must implement.
 */
export interface MinimaxStreamClient {
  readonly provider: "openai-compat" | "anthropic-compat";

  streamChat(options: ProviderChatOptions): AsyncGenerator<NormalizedStreamEvent>;

  /**
   * Returns the input token count for a request, or undefined if the
   * provider does not support a token-counting endpoint.
   */
  countInputTokens?(
    options: ProviderChatOptions,
  ): Promise<{ inputTokens: number } | undefined>;
}
