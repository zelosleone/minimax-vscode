# MiniMax (coding) for VS Code

Use MiniMax text models from your Token Plan in GitHub Copilot Chat. Speech, video and image generation are not included.

> Also from the same developer: [Lodestar](https://marketplace.visualstudio.com/items?itemName=DenizhanDaklr.lodestar) walks you through how code works, explains anything you hover, and reviews your changes on any model in VS Code, including this extension's. 3 free runs included, then $5 one-time.

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
| **MiniMax: Refresh Models** | Refresh the live catalog immediately instead of waiting for the 30-minute refresh |
| **MiniMax: Switch to Global API (minimax.io)** | Use the international endpoint |
| **MiniMax: Switch to Chinese API (minimaxi.com)** | Use the China endpoint |

Requires VS Code 1.111+. MIT license.

## Missing models

MiniMax-M3.1-Flash-Preview is supported by the API, but currently requires an
[M Plan Subscription Key](https://platform.minimax.io/docs/guides/text-generation).
Seeing it in MiniMax's web app does not confirm API access for your key.

First update the extension and reload VS Code. In user settings, set
`minimax.visibleModels` to `[]` to show all live chat models. Check that
`minimax.apiBaseUrl` matches the platform that issued your Subscription Key:
`https://api.minimax.io/v1` for Global; the extension's China shortcut uses
`https://api.minimaxi.com/v1`. Current
[China documentation](https://platform.minimax.cn/docs/guides/text-generation)
also lists `https://api.minimax.cn/v1`, which can be entered directly.
Re-enter the matching key under **Manage Models > MiniMax** after changing regions.

Run **MiniMax: Refresh Models** and check **Output > MiniMax** for catalog failures.
The catalog refreshes every 30 minutes; its cache is scoped to the endpoint and
key. On a MiniMax API/network failure, the last good catalog for that scope is
kept. A models.dev failure uses cached metadata or default limits while still
showing all live model ids. Models omitted by the API cannot be added through
`minimax.visibleModels`; `minimax.customModels` is not supported.

To distinguish API access from an extension issue, request `GET {baseUrl}/models`
with the same key locally and check for the exact id
`MiniMax-M3.1-Flash-Preview` in `data[].id`. A successful
`POST {baseUrl}/chat/completions` using that id confirms inference access;
a catalog listing alone does not. Never post your key or Authorization header.

## Development

Run `npm ci`, `npm test`, `npm run compile`, and `npm run build`. Tests exercise
catalog refreshes with mocked HTTP/VS Code APIs; they do not require credentials
or make inference calls.
