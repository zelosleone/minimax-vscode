import * as vscode from "vscode";
import { MiniMaxProvider } from "./providers/MiniMaxProvider";
import { MiniMaxAuthentication } from "./providers/MiniMaxAuthentication";
import { MiniMaxClient, MiniMaxError } from "./api/MiniMaxClient";
import { TokenCounter } from "./utils/TokenCounter";

async function setApiKey(authManager: MiniMaxAuthentication): Promise<void> {
  await authManager.promptForApiKey();
}

async function clearApiKey(authManager: MiniMaxAuthentication): Promise<void> {
  await authManager.deleteApiKey();
  vscode.window.showInformationMessage("MiniMax API key cleared");
}

async function testConnection(authManager: MiniMaxAuthentication): Promise<void> {
  const key = await authManager.getApiKey();
  if (!key) {
    const shouldSetKey = await vscode.window.showInformationMessage(
      "API key is not set. Would you like to set it now?",
      "Set API Key",
    );
    if (shouldSetKey === "Set API Key") {
      await authManager.promptForApiKey();
    }
    return;
  }

  const client = new MiniMaxClient();

  try {
    const stream = client.streamChat(
      "MiniMax-M2.5",
      [{ role: "user", content: "Ping" }],
      {
        apiKey: key,
        maxTokens: 1,
        temperature: 1,
      },
    );
    for await (const _ of stream) {
      break;
    }
    vscode.window.showInformationMessage("MiniMax provider test succeeded.");
  } catch (error) {
    if (error instanceof MiniMaxError && error.statusCode === 401) {
      vscode.window.showErrorMessage("Invalid API key. Please set a new key.");
      return;
    }

    if (error instanceof Error) {
      vscode.window.showErrorMessage(`MiniMax provider test failed: ${error.message}`);
      return;
    }

    vscode.window.showErrorMessage(`MiniMax provider test failed: ${String(error)}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const authManager = new MiniMaxAuthentication(context.secrets);
  const apiClient = new MiniMaxClient();
  const tokenCounter = new TokenCounter();
  const provider = new MiniMaxProvider(apiClient, authManager, tokenCounter);

  const manageActions: Record<string, () => Promise<void>> = {
    "Set API Key": () => setApiKey(authManager),
    "Clear API Key": () => clearApiKey(authManager),
    "Test Connection": () => testConnection(authManager),
  };

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("minimax", provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("minimax.visibleModels")) {
        provider.notifyModelsChanged();
      }
    }),
    vscode.commands.registerCommand("minimax-vscode.setApiKey", async () => {
      await setApiKey(authManager);
    }),
    vscode.commands.registerCommand("minimax-vscode.clearApiKey", async () => {
      await clearApiKey(authManager);
    }),
    vscode.commands.registerCommand("minimax-vscode.manage", async () => {
      const choice = await vscode.window.showQuickPick(Object.keys(manageActions), {
        placeHolder: "Manage MiniMax provider",
      });
      const action = choice ? manageActions[choice] : undefined;
      if (!action) {
        return;
      }
      await action();
    }),
  );
}

export function deactivate(): void {}
