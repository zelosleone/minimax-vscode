# MiniMax AI VSCode Extension

A VSCode extension that integrates MiniMax Coding Plan models as a language model provider using the VSCode Language Model Chat Provider API.

## Features

- **Coding Plan Models**: Uses MiniMax-M2.5, MiniMax-M2.1, or MiniMax-M2
- **Global Endpoint**: Uses `https://api.minimax.io/v1`
- **Interleaved tool reasoning** continuity with structured thinking blocks.

## Requirements

- VSCode 1.109.0 or later
- MiniMax API key (get one at [MiniMax Dashboard](https://platform.minimax.io/user-center/payment/coding-plan))

### Thinking Blocks (Proposed API)

When proposed API is enabled, structured thinking uses `LanguageModelThinkingPart`.
Otherwise, the extension uses text-mode thinking blocks (`<think>...</think>`), while preserving full assistant responses for interleaved tool reasoning continuity.

Optional (VS Code Insiders + proposed API):

```bash
code-insiders --enable-proposed-api denizhandaklr.minimax-vscode
```


## Installation

1. Open VSCode
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "MiniMax AI"
4. Click Install

### Setting Up Your API Key

1. Get your API key from [MiniMax Dashboard](https://platform.minimax.io)
2. Open Command Palette
3. Run `MiniMax: Set API Key`
4. Enter your API key when prompted

### Model Visibility

Set `minimax.visibleModels` in settings to control which MiniMax models appear in the model picker.

## Supported Models

| Model | Context Length |
|-------|---------------|
| MiniMax-M2.5 | 204.8K tokens |
| MiniMax-M2.1 | 204.8K tokens |
| MiniMax-M2 | 204.8K tokens |

## Usage

Once configured, you can use MiniMax AI with VSCode's built-in chat features:

1. Open the Chat view (Ctrl+Shift+Y)
2. Select "MiniMax AI" as the provider
3. Start chatting!


## Security

- API keys are stored securely using VSCode's SecretStorage
- No sensitive data is logged
- All API calls use HTTPS

## License

MIT
