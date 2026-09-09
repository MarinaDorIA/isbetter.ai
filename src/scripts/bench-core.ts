/* Pure benchmark logic: the suite format, pulling the structured answer out
   of a model reply, and grading it. Kept DOM-free so it can be tested. */

export interface BenchCase {
  /** A question (text suites) or the JSON arguments of a call (js suites). */
  q: string;
  /** Accepted answer(s), or the JSON value the call must return. */
  a: string | string[];
}
export type BenchLang = "text" | "js";
export interface BenchSuite {
  name: string;
  /** `text` asks each question; `js` asks for one function and runs it here. */
  lang?: BenchLang;
  /** js only: the problem statement and the function the model must define. */
  task?: string;
  entry?: string;
  cases: BenchCase[];
}

/** The contract every model is held to — one JSON object, nothing else. */
export const BENCH_SYSTEM = `You are being benchmarked. Answer the question with a single JSON object and nothing else:
{"answer": "<your answer>"}
Rules: no markdown, no code fences, no explanation, no extra keys. Keep the answer as short as possible — a word, a name or a number.`;

export const DEFAULT_ENTRY = "solve";

/** Code suites: one request per model, then the tests run in the browser. */
export function codeSystem(suite: BenchSuite): string {
  const entry = suite.entry || DEFAULT_ENTRY;
  const samples = suite.cases
    .slice(0, 3)
    .map((c) => `  ${entry}(${c.q.replace(/^\[|\]$/g, "")}) === ${answerOf(c)}`)
    .join("\n");
  return `You are being benchmarked on code. Write plain JavaScript (ES2022, no imports, no I/O, no network) that defines a function named \`${entry}\`.

Task: ${suite.task?.trim() || "Solve the examples below."}

It must satisfy:
${samples}

Reply with a single JSON object and nothing else:
{"code": "function ${entry}(…) { … }"}
Rules: no markdown, no code fences, no explanation, no extra keys. The value of "code" is the complete source as a JSON string.`;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const answerOf = (c: BenchCase) => (Array.isArray(c.a) ? c.a[0] : c.a);

/**
 * Accepts the simplest thing anyone would hand-write: a bare array of cases,
 * or an object with `cases`. Field aliases exist because everyone names these
 * two columns differently. A `js` suite writes its arguments and expected
 * value as JSON instead — `{"in": [[1,2]], "out": 3}` — and they are kept as
 * JSON text so editor, storage and report treat both kinds the same.
 */
export function parseSuite(raw: string): BenchSuite {
  const json = JSON.parse(raw) as any;
  const list = Array.isArray(json) ? json : json?.cases;
  if (!Array.isArray(list)) throw new Error('Expected an array of cases, or {"cases": [...]}.');
  const lang: BenchLang = json?.lang === "js" ? "js" : "text";
  const cases: BenchCase[] = list.map((item: any, i: number) => {
    if (lang === "js") {
      const args = item?.in ?? item?.args ?? item?.q;
      const out = item?.out ?? item?.expected ?? item?.a;
      if (args === undefined) throw new Error(`Case ${i + 1} has no "in" arguments.`);
      return {
        q: typeof args === "string" ? args : JSON.stringify(args),
        a: typeof out === "string" && out.trim().startsWith('"') ? out : JSON.stringify(out ?? null),
      };
    }
    const q = str(item?.q ?? item?.question ?? item?.prompt).trim();
    const rawA = item?.a ?? item?.answer ?? item?.expected;
    if (!q) throw new Error(`Case ${i + 1} has no question.`);
    return { q, a: Array.isArray(rawA) ? rawA.map(str) : str(rawA) };
  });
  if (!cases.length) throw new Error("The suite has no cases.");
  return {
    name: str(json?.name).trim() || "Benchmark",
    lang,
    ...(lang === "js"
      ? { task: str(json?.task ?? json?.prompt).trim(), entry: str(json?.entry).trim() || DEFAULT_ENTRY }
      : {}),
    cases,
  };
}

/** Export mirrors what parseSuite accepts, so a round trip is lossless. */
export function suiteToJSON(suite: BenchSuite): string {
  if (suite.lang !== "js")
    return JSON.stringify({ name: suite.name, cases: suite.cases }, null, 2);
  return JSON.stringify(
    {
      name: suite.name,
      lang: "js",
      task: suite.task || "",
      entry: suite.entry || DEFAULT_ENTRY,
      cases: suite.cases.map((c) => ({
        in: safeJSON(c.q, []),
        out: safeJSON(answerOf(c), null),
      })),
    },
    null,
    2,
  );
}

/** Editor fields are free text: keep whatever does not parse as a raw string. */
export function safeJSON(text: string, fallback: unknown): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim() === "" ? fallback : text;
  }
}

/** Structural equality with a float tolerance, for graded call results. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number")
    return Math.abs(a - b) < 1e-9 || Object.is(a, b);
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (key) =>
      kb.includes(key) && deepEqual((a as any)[key], (b as any)[key]),
  );
}

/**
 * Models drift from the JSON contract (fences, a stray sentence, a bare
 * value). Take the JSON when it is there, the raw text when it is not.
 */
export function extractAnswer(text: string): string {
  const clean = text.replace(/```(?:json)?/gi, "").trim();
  const candidates = [clean];
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(clean.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate);
      if (json && typeof json === "object" && !Array.isArray(json)) {
        const value =
          (json as any).answer ?? (json as any).code ?? (json as any).result ?? (json as any).value;
        if (value !== undefined) return str(value).trim();
      }
      if (typeof json === "string" || typeof json === "number") return String(json);
    } catch {}
  }
  return clean;
}

/** Case, accent, punctuation and article noise are not what is being tested. */
const norm = (v: string) =>
  v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[.,;:!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function grade(expected: string | string[], answer: string): boolean {
  const options = (Array.isArray(expected) ? expected : [expected]).filter((o) => o !== "");
  if (!options.length) return false;
  const got = norm(answer);
  return options.some((option) => {
    const want = norm(option);
    if (!want) return false;
    if (got === want) return true;
    const a = Number(got.replace(",", "."));
    const b = Number(want.replace(",", "."));
    // ponytail: exact match after normalisation, plus numeric equality. Swap in
    // a judge model here if the suites ever need free-form answers.
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
  });
}

/* ------------------------------ stored runs ------------------------------ */
export interface BenchCell {
  ok: boolean;
  answer: string;
  error?: string;
  ms: number;
  cost: number;
}
export interface BenchRun {
  ts: number;
  name?: string; // user-given title, shown in the report
  suite: BenchSuite;
  /** One row per model; a null cell is a case that has not answered yet. */
  rows: { key: string; cells: (BenchCell | null)[] }[];
}

export const RUNS_KEY = "ab:bench:runs";
export const RUNS_LIMIT = 10;

export function loadRuns(): BenchRun[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RUNS_KEY) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/** Drops the oldest runs when the quota says no, same as battle history. */
export function saveRuns(list: BenchRun[]): BenchRun[] {
  let out = list.slice(0, RUNS_LIMIT);
  while (out.length) {
    try {
      localStorage.setItem(RUNS_KEY, JSON.stringify(out));
      return out;
    } catch {
      out = out.slice(0, -1);
    }
  }
  localStorage.removeItem(RUNS_KEY);
  return out;
}
