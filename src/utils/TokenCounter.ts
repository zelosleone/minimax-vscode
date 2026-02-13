export class TokenCounter {
  private readonly charsPerToken = 4;

  estimateTokens(text: string): number {
    if (!text || text.length === 0) {
      return 0;
    }
    return Math.ceil(text.length / this.charsPerToken);
  }
}
