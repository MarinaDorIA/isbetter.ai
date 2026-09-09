/* Runs model-written JavaScript against a suite's cases, in the browser.
 *
 * A Worker, not an iframe: an infinite loop is the failure mode you actually
 * hit, and only a Worker can be killed mid-loop without freezing the page.
 * The worker has no DOM and no localStorage, and its bootstrap removes the
 * network and thread APIs before the model's code is evaluated.
 *
 * ponytail: this contains accidents, not attacks — the code still runs on the
 * user's machine. If suites ever come from strangers, host the worker inside a
 * sandboxed null-origin iframe (or run it server-side) instead of hardening it
 * from the inside.
 */
import { deepEqual, safeJSON, type BenchCase } from "./bench-core";

export interface CaseResult {
  ok: boolean;
  got: string; // what the function returned, or the error it threw
  ms: number;
}

const WORKER_SOURCE = `
for (const name of ["fetch", "XMLHttpRequest", "importScripts", "WebSocket", "Worker", "indexedDB", "caches"]) {
  try { delete self[name]; self[name] = undefined; } catch {}
}
self.onmessage = (event) => {
  const { code, entry, cases } = event.data;
  let fn;
  try {
    // The reply may be a bare function, a declaration, or several statements.
    fn = new Function(code + "\\n;return typeof " + entry + " === 'function' ? " + entry + " : undefined;")();
  } catch (error) {
    self.postMessage({ fatal: "does not run: " + (error && error.message || error) });
    return;
  }
  if (typeof fn !== "function") {
    self.postMessage({ fatal: "no function named " + entry });
    return;
  }
  const results = cases.map((args) => {
    const started = Date.now();
    try {
      const value = fn.apply(null, args);
      return { value: JSON.stringify(value === undefined ? null : value), ms: Date.now() - started };
    } catch (error) {
      return { error: String((error && error.message) || error), ms: Date.now() - started };
    }
  });
  self.postMessage({ results });
};
`;

/** Every case of one model's program; rejects nothing, reports instead. */
export function runJs(
  code: string,
  entry: string,
  cases: BenchCase[],
  timeoutMs = 5000,
): Promise<{ fatal?: string; results: CaseResult[] }> {
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  const worker = new Worker(url);
  const failAll = (message: string) => ({
    fatal: message,
    results: cases.map(() => ({ ok: false, got: message, ms: 0 })),
  });

  return new Promise((resolve) => {
    const finish = (value: { fatal?: string; results: CaseResult[] }) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(
      () => finish(failAll(`timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );

    worker.onerror = (event) => finish(failAll(event.message || "worker error"));
    worker.onmessage = (event) => {
      const data = event.data as {
        fatal?: string;
        results?: { value?: string; error?: string; ms: number }[];
      };
      if (data.fatal || !data.results) return finish(failAll(data.fatal || "no result"));
      finish({
        results: data.results.map((result, i) => {
          if (result.error) return { ok: false, got: `threw: ${result.error}`, ms: result.ms };
          const value = safeJSON(result.value ?? "null", null);
          const expected = safeJSON(
            Array.isArray(cases[i].a) ? (cases[i].a as string[])[0] : (cases[i].a as string),
            null,
          );
          return { ok: deepEqual(value, expected), got: result.value ?? "undefined", ms: result.ms };
        }),
      });
    };

    try {
      worker.postMessage({
        code,
        entry,
        cases: cases.map((c) => {
          const args = safeJSON(c.q, []);
          return Array.isArray(args) ? args : [args];
        }),
      });
    } catch (error) {
      finish(failAll(error instanceof Error ? error.message : String(error)));
    }
  });
}
