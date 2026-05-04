import * as vscode from "vscode";
import type { MiniMaxToolDefinition } from "../api/types";

export interface AccumulatedToolCall {
  index: number;
  id?: string;
  name?: string;
  arguments: string;
}

export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): MiniMaxToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const converted: MiniMaxToolDefinition[] = [];
  for (const tool of tools) {
    const name = normalizeToolName(tool.name);
    if (!name) {
      continue;
    }

    converted.push({
      type: "function",
      function: {
        name,
        description: normalizeToolDescription(tool.description),
        parameters: normalizeToolParameters(tool.inputSchema),
      },
    });
  }

  return converted.length > 0 ? converted : undefined;
}

export function resolveToolChoice(
  options: vscode.ProvideLanguageModelChatResponseOptions,
  tools: readonly MiniMaxToolDefinition[] | undefined,
): "auto" | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return "auto"; 
}

export function accumulateToolCalls(
  choice: { delta?: unknown },
  pending: Map<number, AccumulatedToolCall>,
): void {
  const delta = choice.delta as { tool_calls?: unknown } | undefined;
  if (!Array.isArray(delta?.tool_calls)) {
    return;
  }

  for (const rawCall of delta.tool_calls) {
    if (!rawCall || typeof rawCall !== "object") {
      continue;
    }

    const call = rawCall as {
      index?: unknown;
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const index =
      typeof call.index === "number" && Number.isInteger(call.index) && call.index >= 0
        ? call.index
        : pending.size;
    const current = pending.get(index) ?? { index, arguments: "" };

    if (typeof call.id === "string" && call.id.length > 0) {
      current.id = call.id;
    }
    if (typeof call.function?.name === "string" && call.function.name.length > 0) {
      current.name = call.function.name;
    }
    if (typeof call.function?.arguments === "string" && call.function.arguments.length > 0) {
      current.arguments += call.function.arguments;
    }

    pending.set(index, current);
  }
}

export function isToolCallFinish(choice: { finish_reason?: unknown }): boolean {
  return choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call";
}

export function reportToolCalls(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  pending: Map<number, AccumulatedToolCall>,
): void {
  const orderedCalls = [...pending.values()].sort((a, b) => a.index - b.index);
  for (const call of orderedCalls) {
    if (!call.id || !call.name) {
      continue;
    }

    progress.report(
      new vscode.LanguageModelToolCallPart(
        call.id,
        call.name,
        parseToolArguments(call.arguments),
      ),
    );
  }
}

function normalizeToolName(name: string | undefined): string | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeToolDescription(description: string | undefined): string | undefined {
  if (typeof description !== "string") {
    return undefined;
  }
  const trimmed = description.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeToolParameters(inputSchema: unknown): Record<string, unknown> {
  const fallback: Record<string, unknown> = {
    type: "object",
    properties: {},
  };

  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return fallback;
  }

  const schema = { ...(inputSchema as Record<string, unknown>) };
  if (!("type" in schema)) {
    schema.type = "object";
  }

  if (schema.type === "object" && !("properties" in schema)) {
    schema.properties = {};
  }

  return schema;
}

function parseToolArguments(raw: string): object {
  const text = raw.trim();
  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as object;
    }
    return { value: parsed };
  } catch {
    return { rawArguments: raw };
  }
}
