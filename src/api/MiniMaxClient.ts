// Re-export the OpenAI-compat client under the legacy name for backwards
// compatibility with existing import paths. New code should import from
// `./MiniMaxOpenAIClient` or `./MiniMaxAnthropicClient` directly.
export {
  MiniMaxOpenAIClient as MiniMaxClient,
  MiniMaxError,
} from "./MiniMaxOpenAIClient";
