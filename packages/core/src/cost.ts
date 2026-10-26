/** USD per 1M tokens. Unknown models fall back to `default` and are flagged as estimates. */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "orbix-heuristic": { input: 0, output: 0 },
  default: { input: 1.0, output: 4.0 },
};

export function modelCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = MODEL_PRICES[model] ?? MODEL_PRICES.default!;
  return (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
}

/** Rough token estimate (~4 chars/token) used only where the provider reports no usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
