import { MiniMaxError } from "../api/MiniMaxError";
import { MiniMaxAuthentication } from "./MiniMaxAuthentication";

export class MiniMaxErrorMapper {
  static async throwMappedError(error: unknown, authManager: MiniMaxAuthentication): Promise<never> {
    if (error instanceof MiniMaxError) {
      if (error.statusCode === 401) {
        await authManager.deleteApiKey();
        throw new Error(
          "Invalid API key. Please set a new one using the API key navigation action in the MiniMax model picker.",
        );
      }
      if (error.statusCode === 429) {
        throw new Error("Rate limit exceeded. Please wait and try again.");
      }
      throw new Error(`MiniMax API error: ${error.message}`);
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error(String(error));
  }
}
