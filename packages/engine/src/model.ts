import { z } from "zod";
import { ExecutionError, classifyHttpStatus, modelCostUsd } from "@orbix/core";

export const HEURISTIC_MODEL = "orbix-heuristic";
export const HASH_EMBEDDING_MODEL = "orbix-hash-256";
export const EMBEDDING_DIM = 256;

export interface CompletionResult<T> {
  data: T;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface ModelClient {
  /** Model id recorded on every usage row. */
  readonly name: string;
  /** True when no LLM is configured and deterministic, source-grounded heuristics are used. */
  readonly heuristic: boolean;
  readonly embeddingModel: string;
  completeJson<T>(input: { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number; timeoutMs: number }): Promise<CompletionResult<T>>;
  embed(texts: string[]): Promise<number[][]>;
}

/** OpenAI-compatible chat completions with JSON output validated by Zod (one repair attempt). */
export class OpenAICompatibleModel implements ModelClient {
  readonly heuristic = false;
  constructor(
    private readonly cfg: { baseUrl: string; apiKey: string; model: string; embeddingModel: string },
  ) {}

  get name(): string {
    return this.cfg.model;
  }
  get embeddingModel(): string {
    return this.cfg.embeddingModel;
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new ExecutionError(classifyHttpStatus(res.status), `Model API ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
      return JSON.parse(text) as T;
    } catch (e) {
      if (e instanceof ExecutionError) throw e;
      throw new ExecutionError("transient", `Model API request failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async completeJson<T>(input: { system: string; user: string; schema: z.ZodType<T>; maxTokens?: number; timeoutMs: number }): Promise<CompletionResult<T>> {
    const jsonSchema = JSON.stringify(z.toJSONSchema(input.schema));
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: `${input.system}\n\nRespond with a single JSON object matching this JSON Schema:\n${jsonSchema}` },
      { role: "user", content: input.user },
    ];
    let tokensIn = 0;
    let tokensOut = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.post<{
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      }>(
        "/chat/completions",
        { model: this.cfg.model, messages, response_format: { type: "json_object" }, max_tokens: input.maxTokens ?? 2000, temperature: 0.2 },
        input.timeoutMs,
      );
      tokensIn += res.usage?.prompt_tokens ?? 0;
      tokensOut += res.usage?.completion_tokens ?? 0;
      const content = res.choices[0]?.message.content ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = undefined;
      }
      const result = input.schema.safeParse(parsed);
      if (result.success) {
        return { data: result.data, model: this.cfg.model, tokensIn, tokensOut, costUsd: modelCostUsd(this.cfg.model, tokensIn, tokensOut) };
      }
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: `That output failed validation: ${result.error.message.slice(0, 800)}. Return corrected JSON only.` });
    }
    throw new ExecutionError("permanent", "Model output failed schema validation twice");
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.post<{ data: Array<{ embedding: number[] }> }>(
      "/embeddings",
      { model: this.cfg.embeddingModel, input: texts, dimensions: EMBEDDING_DIM },
      30_000,
    );
    return res.data.map((d) => d.embedding);
  }
}

/** Deterministic fallback for development without an LLM. Never used when NODE_ENV=production. */
export class HeuristicModel implements ModelClient {
  readonly name = HEURISTIC_MODEL;
  readonly heuristic = true;
  readonly embeddingModel = HASH_EMBEDDING_MODEL;

  async completeJson<T>(): Promise<CompletionResult<T>> {
    throw new ExecutionError("permanent", "Heuristic model has no free-form completion; callers use deterministic implementations");
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(hashEmbedding);
  }
}

/** Feature-hashed bag of unigrams+bigrams, L2-normalised. Lexical, not semantic — labelled as such. */
export function hashEmbedding(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const grams = [...tokens, ...tokens.slice(1).map((t, i) => `${tokens[i]}_${t}`)];
  for (const g of grams) {
    let h = 2166136261;
    for (let i = 0; i < g.length; i++) h = Math.imul(h ^ g.charCodeAt(i), 16777619);
    const idx = (h >>> 0) % EMBEDDING_DIM;
    v[idx]! += (h & 0x80000000) === 0 ? 1 : -1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function createModelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelClient {
  const apiKey = env.ORBIX_LLM_API_KEY;
  if (apiKey) {
    return new OpenAICompatibleModel({
      baseUrl: env.ORBIX_LLM_BASE_URL || "https://api.openai.com/v1",
      apiKey,
      model: env.ORBIX_LLM_MODEL || "gpt-4.1-mini",
      embeddingModel: env.ORBIX_EMBEDDING_MODEL || "text-embedding-3-small",
    });
  }
  if (env.NODE_ENV === "production") {
    throw new Error("ORBIX_LLM_API_KEY is required in production; the heuristic model is development-only.");
  }
  return new HeuristicModel();
}
