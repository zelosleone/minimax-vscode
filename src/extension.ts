import * as vscode from "vscode";
import { MiniMaxProvider } from "./providers/MiniMaxProvider";
import { MiniMaxAuthentication } from "./providers/MiniMaxAuthentication";
import { TokenCounter } from "./utils/TokenCounter";
import { registerGenerateCommitMessageCommand } from "./commands/generateCommitMessage";
import {
  CONFIG_SECTION,
  VISIBLE_MODELS_KEY,
  API_BASE_URL_KEY,
  API_FORMAT_KEY,
  ANTHROPIC_BASE_URL_KEY,
  THINKING_ENABLED_KEY,
  THINKING_MODE_KEY,
  apiFormatLabel,
  getApiFormat,
  getThinkingMode,
  isThinkingEnabled,
  setApiFormat,
  setThinkingMode,
  thinkingModeDescription,
  thinkingModeLabel,
  type ApiFormat,
  type ThinkingMode,
} from "./utils/ModelConfig";

export function activate(context: vscode.ExtensionContext): void {
  const authManager = new MiniMaxAuthentication(context.secrets);
  const tokenCounter = new TokenCounter();
  const provider = new MiniMaxProvider(authManager, tokenCounter);

  const switchRegion = async (host: "api.minimax.io" | "api.minimaxi.com", label: string) => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update(API_BASE_URL_KEY, `https://${host}/v1`, vscode.ConfigurationTarget.Global);
    await config.update(ANTHROPIC_BASE_URL_KEY, `https://${host}/anthropic`, vscode.ConfigurationTarget.Global);
    provider.notifyModelsChanged();
    vscode.window.showInformationMessage(
      `MiniMax: Switched to ${label} (${host}) for both OpenAI and Anthropic endpoints. Active: ${apiFormatLabel(getApiFormat())}.`,
    );
  };

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("minimax", provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(`${CONFIG_SECTION}.${VISIBLE_MODELS_KEY}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${API_BASE_URL_KEY}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${API_FORMAT_KEY}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${ANTHROPIC_BASE_URL_KEY}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${THINKING_ENABLED_KEY}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${THINKING_MODE_KEY}`)
      ) {
        provider.notifyModelsChanged();
      }
      // Confirm setting changes so users get feedback no matter where the
      // change came from (settings UI, chat model config flow, or a command).
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${API_FORMAT_KEY}`)) {
        vscode.window.setStatusBarMessage(
          `MiniMax: API endpoint set to ${apiFormatLabel(getApiFormat())}`,
          5000,
        );
      }
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${THINKING_MODE_KEY}`)) {
        vscode.window.setStatusBarMessage(
          `MiniMax: Thinking set to ${thinkingModeLabel(getThinkingMode())} (M3)`,
          5000,
        );
      } else if (event.affectsConfiguration(`${CONFIG_SECTION}.${THINKING_ENABLED_KEY}`)) {
        // Legacy boolean fallback for users still on the old key.
        vscode.window.setStatusBarMessage(
          `MiniMax: Thinking ${isThinkingEnabled() ? "enabled" : "disabled"} (M3)`,
          5000,
        );
      }
    }),
    vscode.commands.registerCommand("minimax.switchToGlobal", () =>
      switchRegion("api.minimax.io", "Global API"),
    ),
    vscode.commands.registerCommand("minimax.switchToChina", () =>
      switchRegion("api.minimaxi.com", "Chinese API"),
    ),
    vscode.commands.registerCommand("minimax.selectApiFormat", async () => {
      const current = getApiFormat();
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: "Anthropic SDK (Messages API)",
            description: "api.minimax.io/anthropic — recommended by MiniMax; native thinking blocks, count_tokens",
            detail: current === "anthropic-compat" ? "$(check) Currently active" : undefined,
            format: "anthropic-compat" as ApiFormat,
          },
          {
            label: "OpenAI SDK (Chat Completions)",
            description: "api.minimax.io/v1 — legacy default",
            detail: current === "openai-compat" ? "$(check) Currently active" : undefined,
            format: "openai-compat" as ApiFormat,
          },
        ],
        { placeHolder: `Select the API endpoint for MiniMax requests (current: ${apiFormatLabel(current)})` },
      );
      if (!picked) {
        return;
      }
      if (picked.format === current) {
        vscode.window.showInformationMessage(`MiniMax: Already using ${apiFormatLabel(current)}.`);
        return;
      }
      await setApiFormat(picked.format);
      provider.notifyModelsChanged();
      vscode.window.showInformationMessage(`MiniMax: Now using ${apiFormatLabel(picked.format)}.`);
    }),
    vscode.commands.registerCommand("minimax.toggleThinking", async () => {
      const next = !isThinkingEnabled();
      await setThinkingMode(next ? "adaptive" : "off");
      provider.notifyModelsChanged();
      vscode.window.showInformationMessage(
        `MiniMax: Thinking ${next ? "enabled" : "disabled"} for M3. M2.x models always emit thinking.`,
      );
    }),
    vscode.commands.registerCommand("minimax.selectThinkingMode", async () => {
      const current = getThinkingMode();
      const picked = await vscode.window.showQuickPick(
        (
          [
            { mode: "off" as ThinkingMode, label: "$(circle-slash) Off" },
            { mode: "adaptive" as ThinkingMode, label: "$(lightbulb) On (adaptive)" },
            { mode: "auto" as ThinkingMode, label: "$(settings-gear) Auto" },
          ]
        ).map((entry) => ({
          label: entry.label,
          description: thinkingModeDescription(entry.mode),
          detail: current === entry.mode ? "$(check) Currently active" : undefined,
          mode: entry.mode,
        })),
        {
          placeHolder: `Select the thinking mode for MiniMax requests (current: ${thinkingModeLabel(current)})`,
        },
      );
      if (!picked) {
        return;
      }
      if (picked.mode === current) {
        vscode.window.showInformationMessage(
          `MiniMax: Thinking already set to ${thinkingModeLabel(current)}.`,
        );
        return;
      }
      await setThinkingMode(picked.mode);
      provider.notifyModelsChanged();
      vscode.window.showInformationMessage(
        `MiniMax: Thinking set to ${thinkingModeLabel(picked.mode)}.`,
      );
    }),
    vscode.commands.registerCommand("minimax.clearApiKey", async () => {
      await authManager.deleteApiKey();
      provider.clearApiKeyCache();
      provider.notifyModelsChanged();
      vscode.window.showInformationMessage("MiniMax: API key cleared. Pick a model to set a new one.");
    }),
    registerGenerateCommitMessageCommand(),
  );
}

export function deactivate(): void {}
