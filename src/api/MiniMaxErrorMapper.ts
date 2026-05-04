import OpenAI from "openai";
import { MiniMaxError } from "./MiniMaxError";

const ERROR_MESSAGES: Record<string, string> = {
  "1000": "Unknown error. Please try again later.",
  "1001": "Request timed out. Please try again.",
  "1002": "Rate limit exceeded. Please wait a moment and try again.",
  "1004": "Invalid API key or unauthorized request.",
  "1008": "Insufficient balance. Please check your MiniMax Token Plan.",
  "1024": "Internal server error. Please try again later.",
  "1026": "Input flagged by content safety system. Please adjust your prompt.",
  "1027": "Output flagged by content safety system. Please adjust your prompt.",
  "1033": "Internal system error. Please try again later.",
  "1039": "Token limit exceeded. Please reduce the message length and try again.",
  "1041": "Connection limit reached. Please wait and try again.",
  "1042": "Input contains excessive invisible characters. Please clean up your input.",
  "2049": "Invalid API key. Please check your key and try again.",
};

export function toMiniMaxError(error: unknown): MiniMaxError {
  if (error instanceof MiniMaxError) {
    return error;
  }

  if (error instanceof OpenAI.APIError) {
    const statusCode = error.status ?? 0;
    const minimaxCode = extractCode(error);
    const message = getMessageForCode(minimaxCode, statusCode, error.message);
    const code = minimaxCode ?? (statusCode === 401 ? "AUTHENTICATION_ERROR" : "API_ERROR");
    return new MiniMaxError(message, code, statusCode);
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new MiniMaxError("Request timeout", "TIMEOUT");
  }

  if (error instanceof Error) {
    return new MiniMaxError(error.message, "NETWORK_ERROR");
  }

  return new MiniMaxError(String(error), "UNKNOWN_ERROR");
}

function getMessageForCode(code: string | undefined, statusCode: number, fallback: string): string {
  if (code && ERROR_MESSAGES[code]) {
    return ERROR_MESSAGES[code];
  }
  if (statusCode === 429) {
    return "Rate limit exceeded. Please wait and try again.";
  }
  if (statusCode === 401) {
    return "Invalid API key. Please set a new one.";
  }
  return fallback;
}

function extractCode(error: unknown): string | undefined {
  const code = (error as { code?: string | null }).code;
  if (typeof code === "string" && code.length > 0) {
    return code;
  }

  const rawError = (error as { error?: Record<string, unknown> }).error;
  if (rawError && typeof rawError === "object") {
    const bodyCode = rawError.code;
    if (typeof bodyCode === "string" && bodyCode.length > 0) {
      return bodyCode;
    }
    const bodyStatus = rawError.status;
    if (typeof bodyStatus === "string" && bodyStatus.length > 0) {
      return bodyStatus;
    }
  }

  return undefined;
}

