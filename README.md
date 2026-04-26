# MiniMax (coding) for VS Code

Language model chat provider for GitHub Copilot in VS Code using MiniMax text models with a Token Plan API key.

## Features

- Token Plan API key from [platform.minimax.io](https://platform.minimax.io)
- OpenAI-compatible chat to `https://api.minimax.io/v1`
- Tool calling and reasoning/thinking streaming

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

`minimax.visibleModels` (array of model IDs) controls which models appear in the picker.

## Models

| Model | Context | Max output |
|--------|---------|-----------|
| MiniMax-M2.7 | 204,800 | 128,000 |
| MiniMax-M2.7-highspeed | 204,800 | 128,000 |
| MiniMax-M2.5 | 204,800 | 128,000 |
| MiniMax-M2.5-highspeed | 204,800 | 128,000 |
| MiniMax-M2.1 | 204,800 | 128,000 |
| MiniMax-M2.1-highspeed | 204,800 | 128,000 |
| MiniMax-M2 | 204,800 | 128,000 |

## License

MIT
