/* One-shot chat call against any configured provider.
   The arena streams into cards; benchmarks only need the finished text, so
   this consumes the same SSE stream and hands back the whole answer. */
import { baseUrlLS, keyLS } from "./lib";
import { PROVIDERS, priceFor } from "./providers/registry";
import { localFetchInit } from "./providers/local-endpoint";
import { SSEDecoder } from "./providers/sse";
import type { ProviderId, UsageInfo } from "./providers/types";

export interface ChatResult {
  text: string;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

const trimBase = (url: string) => url.trim().replace(/\/+$/, "");
const credential = (p: ProviderId) => localStorage.getItem(keyLS(p)) || "";
/** `local` stores its endpoint in the credential slot; `litellm` has its own. */
const baseUrl = (p: ProviderId) =>
  PROVIDERS[p].endpoint === "as-credential"
    ? credential(p)
    : localStorage.getItem(baseUrlLS(p)) || "";
const custom = (p: ProviderId) => PROVIDERS[p].endpoint !== undefined;

export const chatUrl = (p: ProviderId) =>
  custom(p) ? `${trimBase(baseUrl(p))}/chat/completions` : PROVIDERS[p].chatUrl;

/** True once the provider has whatever it needs to be called. */
export const isConfigured = (p: ProviderId) =>
  (custom(p) ? baseUrl(p) : credential(p)).trim() !== "";

export async function chatOnce(
  provider: ProviderId,
  model: string,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const prov = PROVIDERS[provider];
  if (!isConfigured(provider)) throw new Error(`${prov.name} is not configured`);
  const started = performance.now();
  const res = await fetch(chatUrl(provider), {
    ...(custom(provider) ? localFetchInit(baseUrl(provider)) : {}),
    method: "POST",
    headers: prov.headers(credential(provider)),
    body: JSON.stringify(prov.body(model, system, user)),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status} ${res.statusText}`;
    try {
      const json = (await res.json()) as { error?: string | { message?: string } };
      msg = (typeof json.error === "string" ? json.error : json.error?.message) || msg;
    } catch {}
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sse = new SSEDecoder();
  let text = "";
  let usage: UsageInfo = {};
  let streamError = "";
  const consume = (events: ReturnType<SSEDecoder["push"]>) => {
    for (const event of events) {
      const data = event.data.trim();
      if (data === "[DONE]") return true;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error || json.type === "error") {
        streamError = json.error?.message || json.error || "stream error";
        return true;
      }
      const chunk = prov.parse(json);
      text += chunk.content;
      if (chunk.usage) usage = { ...usage, ...chunk.usage };
    }
    return false;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      consume(sse.finish(decoder.decode()));
      break;
    }
    if (consume(sse.push(decoder.decode(value, { stream: true })))) {
      await reader.cancel();
      break;
    }
  }
  if (streamError && !text) throw new Error(streamError);

  const promptTokens = usage.prompt_tokens ?? Math.round((system.length + user.length) / 4);
  const completionTokens = usage.completion_tokens ?? Math.round(text.length / 4);
  const price = priceFor(provider, model);
  const cost =
    usage.cost ??
    (price ? promptTokens * price.prompt + completionTokens * price.completion : 0);
  return { text, ms: performance.now() - started, promptTokens, completionTokens, cost };
}
