export type ProviderId =
  | "local"
  | "litellm"
  | "openrouter"
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "deepseek"
  | "kimi"
  | "mistral"
  | "groq"
  | "cerebras";

export interface UsageInfo {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export interface Chunk {
  content: string;
  reasoning: string;
  usage: UsageInfo | null;
  finishReason?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  promptPrice: number | null;
  completionPrice: number | null;
  context: number;
}

export interface Provider {
  id: ProviderId;
  name: string;
  short: string;
  color: string;
  logo: string;
  logoMonochrome?: boolean;
  keyPlaceholder: string;
  keyUrl: string;
  credentialLabel: string;
  credentialHelp?: string;
  modelsUrl: string;
  chatUrl: string;
  /**
   * Set when the user supplies the endpoint, so `modelsUrl` / `chatUrl` above
   * are empty and both are derived from a base URL instead:
   *  - `"as-credential"` — the base URL *is* the credential and there is no key
   *    (`local`: an Ollama or LM Studio server nobody authenticates against).
   *  - `"with-key"` — base URL and API key are separate fields (`litellm`: a
   *    proxy that routes to real providers and wants a virtual key).
   */
  endpoint?: "as-credential" | "with-key";
  /** Labels for the extra base-URL field of a `"with-key"` provider. */
  urlLabel?: string;
  urlPlaceholder?: string;
  browserSupport: "supported" | "variable";
  headers: (credential: string) => Record<string, string>;
  body: (model: string, system: string, user: string) => object;
  parse: (json: unknown) => Chunk;
  parseModels: (json: unknown) => ModelInfo[];
}
