import * as vscode from "vscode";
import { MiniMaxProvider } from "./providers/MiniMaxProvider";
import { MiniMaxAuthentication } from "./providers/MiniMaxAuthentication";
import { MiniMaxClient } from "./api/MiniMaxClient";
import { TokenCounter } from "./utils/TokenCounter";
import {
  CONFIG_SECTION,
  VISIBLE_MODELS_KEY,
  API_BASE_URL_KEY,
} from "./utils/ModelConfig";

export function activate(context: vscode.ExtensionContext): void {
  const authManager = new MiniMaxAuthentication(context.secrets);
  const apiClient = new MiniMaxClient();
  const tokenCounter = new TokenCounter();
  const provider = new MiniMaxProvider(apiClient, authManager, tokenCounter);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("minimax", provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(`${CONFIG_SECTION}.${VISIBLE_MODELS_KEY}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${API_BASE_URL_KEY}`)
      ) {
        provider.notifyModelsChanged();
      }
    }),
    vscode.commands.registerCommand("minimax.switchToGlobal", () => {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
      config
        .update(API_BASE_URL_KEY, "https://api.minimax.io/v1", vscode.ConfigurationTarget.Global)
        .then(() => {
          provider.notifyModelsChanged();
          vscode.window.showInformationMessage("MiniMax: Switched to Global API (api.minimax.io)");
        });
    }),
    vscode.commands.registerCommand("minimax.switchToChina", () => {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
      config
        .update(API_BASE_URL_KEY, "https://api.minimaxi.com/v1", vscode.ConfigurationTarget.Global)
        .then(() => {
          provider.notifyModelsChanged();
          vscode.window.showInformationMessage("MiniMax: Switched to Chinese API (api.minimaxi.com)");
        });
    }),
  );
}

export function deactivate(): void {}
