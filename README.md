# MiniMax (coding) for VS Code

Use MiniMax text models from your Token Plan in GitHub Copilot Chat. Speech, video and image generation are not included.

1. Get a Token Plan API key from [platform.minimax.io](https://platform.minimax.io/user-center/payment/token-plan).
2. In the Copilot Chat model picker, open **Manage Models**, pick **MiniMax** and paste the key.
3. Pick a MiniMax model and set its reasoning effort right in the picker.

The model list comes live from the MiniMax API, and context windows, image support and effort levels come from [models.dev](https://models.dev), so new models show up without an update. Brand-new models appear right away with safe default limits until models.dev lists them. Copilot's context window indicator works as usual.

Reasoning Effort is live per model: Auto, Off and On, or Auto plus levels from Low to Max where the model supports them. Auto sends nothing and lets MiniMax decide. Thinking blocks need VS Code Insiders (proposed API).

## Settings and commands

| | |
|---|---|
| `minimax.apiBaseUrl` | `https://api.minimax.io/v1` by default; use `https://api.minimaxi.com/v1` in China. Must end with `/v1`. |
| `minimax.visibleModels` | Model ids to show. Empty (the default) shows every live model. |
| **MiniMax: Switch to Global API (minimax.io)** | Use the international endpoint |
| **MiniMax: Switch to Chinese API (minimaxi.com)** | Use the China endpoint |

Requires VS Code 1.111+. MIT license.
