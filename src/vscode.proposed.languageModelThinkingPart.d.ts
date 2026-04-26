import "vscode";

declare module "vscode" {
  export class LanguageModelThinkingPart {
    thinking: string;
    metadata?: Readonly<Record<string, unknown>>;

    constructor(thinking: string, metadata?: Readonly<Record<string, unknown>>);
  }
}
