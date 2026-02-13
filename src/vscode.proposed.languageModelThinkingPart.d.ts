import "vscode";

declare module "vscode" {
  export class LanguageModelThinkingPart {
    value: string | string[];
    id?: string;
    metadata?: Readonly<Record<string, unknown>>;

    constructor(
      value: string | string[],
      id?: string,
      metadata?: Readonly<Record<string, unknown>>,
    );
  }
}
