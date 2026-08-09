# MiniMax (coding) for VS Code

Language model chat provider for GitHub Copilot in VS Code using MiniMax text models with a Token Plan API key.

## Features

- Token Plan API key from [platform.minimax.io](https://platform.minimax.io)
- OpenAI-compatible chat to `https://api.minimax.io/v1`
- Tool calling and reasoning/thinking streaming
- M3 model supports image input (multimodal)
- AI-generated SCM commit messages from your staged diff (Conventional Commits)

## Requirements

- VS Code 1.111.0+
- MiniMax Token Plan subscription and API key
- VS Code Insiders is required to render MiniMax thinking blocks via the proposed `languageModelThinkingPart` API

## Setup

1. Get your Token Plan API key from [Account / Token Plan](https://platform.minimax.io/user-center/payment/token-plan)
2. Use the API key navigation action in the model picker
3. Choose a model in the Copilot model picker

Keys are stored in VS Code Secret Storage.

## Configuration

The API endpoint (SDK) and thinking mode can be set three ways:

- **Chat UI**: in the Copilot model picker, choose *Manage Language Models…* → MiniMax; the flow asks for the API key, the API endpoint (OpenAI or Anthropic SDK), and the thinking toggle.
- **Commands**: `MiniMax: Select API Endpoint (OpenAI / Anthropic SDK)` and `MiniMax: Toggle Thinking (M3)`. Every change shows a confirmation message.
- **Settings**: the `minimax.*` settings below.

The model picker shows which SDK is active (e.g. `Token Plan · Anthropic SDK`).

| Setting | Default | Description |
|---|---|---|
| `minimax.apiFormat` | `openai-compat` | API protocol: `openai-compat` (default) or `anthropic-compat` (recommended per MiniMax docs; enables `count_tokens` and native thinking blocks). |
| `minimax.apiBaseUrl` | `https://api.minimax.io/v1` | OpenAI-compatible base URL. Use `https://api.minimaxi.com/v1` for users in China. |
| `minimax.anthropicBaseUrl` | `https://api.minimax.io/anthropic` | Anthropic-compatible base URL. Use `https://api.minimaxi.com/anthropic` for users in China. Ignored when `apiFormat` is `openai-compat`. |
| `minimax.thinkingEnabled` | `true` | Sends `thinking: {type: "adaptive"}` (on) or `{type: "disabled"}` (off) for M3. M2.x always emits thinking. |
| `minimax.visibleModels` | all | Array of model IDs to show in the picker. |
| `minimax.commitMessageGeneration.enabled` | `true` | Show the MiniMax sparkle on the SCM commit-message input. Disable to hide the inline button without uninstalling the extension. |

The `MiniMax: Switch to Global/Chinese API` commands update both the OpenAI and Anthropic base URLs.

## Commit message generation

Generate a Conventional Commits message from your staged changes without leaving VS Code.

- **Command palette**: run `MiniMax: Generate Commit Message`.
- **Toolbar button**: a sparkle appears in the Source Control view's title bar (next to the ✓ / refresh icons) when the Git provider is active. Click it to fill in the commit box.

> VS Code's `scm/inputBox` menu (a button *inside* the message field, like Copilot's) is still a proposed API restricted to Microsoft's own extensions, so third-party extensions can only place the button in the Source Control title toolbar.

The command reads `git diff --cached` plus `git status --short`, sends the result through `vscode.lm` to a MiniMax model, and streams the response into the SCM input box as tokens arrive.

- Defaults to `MiniMax-M2.7-highspeed`. If that model isn't on your `minimax.visibleModels` list, a quick pick appears over all registered MiniMax models.
- Diffs larger than 16,000 characters are truncated before being sent, to keep token usage predictable.
- Generation runs as a Source Control progress task that can be cancelled from the progress indicator.
- The header follows Conventional Commits v1.0.0 (`<type>(<scope>): <description>`), lowercase, imperative mood, ≤ 72 chars. Use the bullet section only when the header alone can't capture the scope.
- Set `minimax.commitMessageGeneration.enabled: false` to hide the toolbar sparkle without uninstalling the extension.

> Requires a MiniMax API key already configured in the Copilot model picker (the command uses the same `vscode.lm` provider the extension exposes).

## Models

| Model | Context | Max input | Max output |
|--------|---------|-----------|-----------|
| MiniMax-M3 | 1,000,000 | 1,000,000 | 131,072 |
| MiniMax-M2.7 | 204,800 | 200,000 | 131,072 |
| MiniMax-M2.7-highspeed | 204,800 | 200,000 | 131,072 |
| MiniMax-M2.5 | 204,800 | 196,000 | 128,000 |
| MiniMax-M2.5-highspeed | 204,800 | 196,000 | 128,000 |
| MiniMax-M2.1 | 204,800 | 196,000 | 128,000 |
| MiniMax-M2.1-highspeed | 204,800 | 196,000 | 128,000 |
| MiniMax-M2 | 204,800 | 192,000 | 128,000 |

## License

MIT
