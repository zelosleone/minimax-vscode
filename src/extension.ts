import * as vscode from "vscode";
import { MiniMaxProvider } from "./providers/MiniMaxProvider";
import { MiniMaxAuthentication } from "./providers/MiniMaxAuthentication";
import { MiniMaxClient } from "./api/MiniMaxClient";
import { TokenCounter } from "./utils/TokenCounter";

export function activate(context: vscode.ExtensionContext): void {
  const authManager = new MiniMaxAuthentication(context.secrets);
  const apiClient = new MiniMaxClient();
  const tokenCounter = new TokenCounter();
  const provider = new MiniMaxProvider(apiClient, authManager, tokenCounter);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("minimax", provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("minimax.visibleModels")) {
        provider.notifyModelsChanged();
      }
    }),
  );
}

export function deactivate(): void {}
