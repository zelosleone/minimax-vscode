import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const MAX_DIFF_CHARS = 16_000;
const COMMAND_ID = "minimax.generateCommitMessage";
const PREFERRED_MODEL_ID = "MiniMax-M2.7-highspeed";
const PREFERRED_MODEL_LABEL = "M2.7 (High-Speed)";

interface GitSnapshot {
  diff: string;
  status: string;
  truncated: boolean;
}

export function registerGenerateCommitMessageCommand(): vscode.Disposable {
  return vscode.commands.registerCommand(COMMAND_ID, async () => {
    try {
      await runGenerateCommitMessage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message) {
        void vscode.window.showErrorMessage(
          `MiniMax: commit message generation failed — ${message}`,
        );
      }
    }
  });
}

async function runGenerateCommitMessage(): Promise<void> {
  const workspaceRoot = pickWorkspaceRoot();
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage(
      "MiniMax: open a workspace with a Git repository to generate a commit message.",
    );
    return;
  }

  const snapshot = await collectGitSnapshot(workspaceRoot);
  if (!snapshot.diff && !snapshot.status) {
    void vscode.window.showInformationMessage(
      "MiniMax: no staged changes to summarise.",
    );
    return;
  }

  const model = await pickMiniMaxModel();
  if (!model) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: `Generating commit message with ${model.name ?? model.id}…`,
      cancellable: true,
    },
    async (_progress, token) => {
      const messages = buildMessages(snapshot);
      let accumulated = "";
      try {
        const response = await model.sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
          if (token.isCancellationRequested) {
            return;
          }
          accumulated += chunk;
          applyToInputBox(accumulated);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`MiniMax: request failed — ${message}`);
      }
    },
  );
}

function pickWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  return folders[0].uri.fsPath;
}

async function collectGitSnapshot(root: string): Promise<GitSnapshot> {
  const cwd = { cwd: root, maxBuffer: 32 * 1024 * 1024 };
  const [diffResult, statusResult] = await Promise.all([
    execFileAsync("git", ["diff", "--cached", "--no-color", "--no-ext-diff"], cwd).catch(
      (err: unknown) => ({
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      }),
    ),
    execFileAsync("git", ["status", "--short", "--branch"], cwd).catch(() => ({
      stdout: "",
      stderr: "",
    })),
  ]);
  if (diffResult.stderr && /Not a git repository/i.test(diffResult.stderr)) {
    throw new Error("not a Git repository");
  }
  const fullDiff = diffResult.stdout || "";
  let diff = fullDiff;
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} characters]`;
    truncated = true;
  }
  return {
    diff: diff.trim(),
    status: (statusResult.stdout || "").trim(),
    truncated,
  };
}

async function pickMiniMaxModel(): Promise<vscode.LanguageModelChat | undefined> {
  const all = await vscode.lm.selectChatModels({ vendor: "minimax" });
  if (all.length === 0) {
    void vscode.window.showErrorMessage(
      "MiniMax: no chat model is registered. Set the API key in the Chat panel model picker first.",
    );
    return undefined;
  }
  const preferred = all.find((model) => model.id === PREFERRED_MODEL_ID);
  if (preferred) {
    return preferred;
  }
  if (all.length === 1) {
    return all[0];
  }
  const picks = all.map((model) => ({
    label: model.name || model.id,
    description: model.id,
    model,
  }));
  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: `Using ${PREFERRED_MODEL_LABEL} by default — confirm or pick another`,
  });
  return chosen?.model ?? all[0];
}

function buildMessages(snapshot: GitSnapshot): vscode.LanguageModelChatMessage[] {
  const userContent = [
    "You generate Conventional Commits v1.0.0 messages for staged Git changes.",
    "Rules:",
    "- First line is a single conventional commit header: <type>(<optional scope>): <description>",
    "- type is one of: feat, fix, docs, refactor, perf, chore, test, build, ci, style, revert",
    "- description is lowercase, imperative mood, no trailing period, <= 72 chars when possible",
    "- Output ONLY the commit message — no explanations, no code fences, no leading prose",
    "- If the change spans multiple concerns, pick the dominant one for the header and include bullet points after a blank line",
    "- Use the bullet section only when the header alone cannot capture the scope; keep bullets terse",
    "- Never invent changes that are not present in the diff",
    "",
    snapshot.status ? `Status:\n${snapshot.status}` : "",
    snapshot.diff ? `Diff (cached):\n\`\`\`diff\n${snapshot.diff}\n\`\`\`` : "",
    snapshot.truncated ? "(diff was truncated to fit context)" : "",
    "Write a single commit message that captures these changes.",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return [vscode.LanguageModelChatMessage.User(userContent)];
}

function applyToInputBox(message: string): void {
  vscode.scm.inputBox.value = stripLeadingNoise(message);
}

function stripLeadingNoise(text: string): string {
  const fenceMatch = /^```(?:[a-z]*\n)?([\s\S]*?)```\s*$/m.exec(text);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return text.replace(/^(?:here'?s|Here'?s) (?:the|your) commit message:?\s*\n+/i, "").trim();
}
