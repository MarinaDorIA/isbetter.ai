/* /bench — write questions with their expected answers, run them against the
   models configured in the arena, and score the replies. Suites and runs live
   in localStorage; nothing leaves the browser except the model calls. */
import { $, esc, fmtCost, fmtDur } from "./lib";
import {
  BENCH_SYSTEM,
  DEFAULT_ENTRY,
  codeSystem,
  extractAnswer,
  grade,
  loadRuns,
  parseSuite,
  saveRuns,
  suiteToJSON,
  type BenchCell as Cell,
  type BenchRun as Run,
  type BenchSuite,
} from "./bench-core";
import { runJs } from "./js-runner";
import { chatOnce, isConfigured } from "./chat";
import { PROVIDERS } from "./providers/registry";
import type { ProviderId } from "./providers/types";

const LS = { suite: "ab:bench:suite", models: "ab:models" };

const els = {
  name: $<HTMLInputElement>("#suite-name"),
  cases: $("#cases"),
  count: $("#case-count"),
  models: $("#models"),
  run: $<HTMLButtonElement>("#run"),
  runLabel: $("#run-label"),
  progress: $("#progress"),
  results: $("#results"),
  lang: $<HTMLSelectElement>("#lang"),
  codeFields: $("#code-fields"),
  task: $<HTMLTextAreaElement>("#task"),
  entry: $<HTMLInputElement>("#entry"),
  runs: $("#runs"),
  importError: $("#import-error"),
  json: $<HTMLTextAreaElement>("#json"),
  jsonStatus: $("#json-status"),
};

const EXAMPLE: BenchSuite = {
  name: "Sanity check",
  cases: [
    { q: "Capital of France? One word.", a: ["Paris", "París"] },
    { q: "What is 17 * 23?", a: "391" },
    { q: "Which planet is known as the Red Planet?", a: "Mars" },
    { q: 'How many letters are in the word "strawberry"?', a: "10" },
  ],
};

const CODE_EXAMPLE: BenchSuite = {
  name: "Sum of an array",
  lang: "js",
  entry: "solve",
  task: "Return the sum of an array of numbers. An empty array sums to 0.",
  cases: [
    { q: "[[1,2,3]]", a: "6" },
    { q: "[[]]", a: "0" },
    { q: "[[-5,5,10]]", a: "10" },
    { q: "[[1.5,2.5]]", a: "4" },
  ],
};

function loadSuite(): BenchSuite {
  try {
    const stored = localStorage.getItem(LS.suite);
    if (stored) return parseSuite(stored);
  } catch {}
  return { name: "", cases: [{ q: "", a: "" }] };
}

let suite = loadSuite();
let run: Run | null = null;
let controller: AbortController | null = null;

// Store the same shape parseSuite reads back, or a js suite would re-encode
// its JSON arguments as strings on every reload ("6" instead of 6).
const saveSuite = () => {
  const json = suiteToJSON(suite);
  localStorage.setItem(LS.suite, json);
  els.json.value = json; // the copy/paste box always mirrors the editor
};
const answerText = (a: string | string[]) => (Array.isArray(a) ? a.join(" | ") : a);
/** The user turn for a code suite; the contract itself is in the system prompt. */
const taskPrompt = (s: BenchSuite) =>
  `${s.task?.trim() || s.name || "Solve the examples."}

Define function \`${s.entry || DEFAULT_ENTRY}\` and return it as JSON.`;
const splitKey = (key: string) => {
  const [provider, ...rest] = key.split("::");
  return { provider: provider as ProviderId, id: rest.join("::") };
};

/* -------------------------------- editor -------------------------------- */
function renderCases() {
  els.count.textContent = String(suite.cases.length);
  els.cases.innerHTML = suite.cases
    .map(
      (c, i) => `
      <div class="grid grid-cols-[1.6rem_minmax(0,1.7fr)_minmax(0,1fr)_1.75rem] items-start gap-2">
        <span class="pt-2 text-right text-[10px] tabular-nums text-[var(--color-ink-faint)]">${i + 1}</span>
        <textarea data-q="${i}" rows="1" placeholder="${suite.lang === "js" ? "Arguments as JSON, e.g. [[1, 2, 3]]" : "Question sent to every model"}"
          class="control-surface no-scrollbar min-h-9 w-full resize-y px-2.5 py-2 text-[12px] outline-none focus:border-[var(--color-accent)]/50">${esc(c.q)}</textarea>
        <input data-a="${i}" value="${esc(answerText(c.a))}" placeholder="${suite.lang === "js" ? "Expected value as JSON" : "Expected answer"}"
          class="control-surface min-h-9 w-full px-2.5 py-2 text-[12px] outline-none focus:border-[var(--color-accent)]/50" />
        <button data-del="${i}" aria-label="Remove case ${i + 1}"
          class="mt-1 grid size-7 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-red-400">
          <svg class="size-3.5"><use href="#i-trash"></use></svg>
        </button>
      </div>`,
    )
    .join("");
}

els.cases.addEventListener("input", (e) => {
  const field = e.target as HTMLTextAreaElement | HTMLInputElement;
  const q = field.dataset.q;
  const a = field.dataset.a;
  if (q !== undefined) suite.cases[Number(q)].q = field.value;
  // A `|` splits the accepted answers, which is how the editor shows a list.
  else if (a !== undefined)
    suite.cases[Number(a)].a =
      suite.lang !== "js" && field.value.includes("|")
      ? field.value.split("|").map((v) => v.trim())
      : field.value;
  else return;
  saveSuite();
});
els.cases.addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>("[data-del]");
  if (!button) return;
  suite.cases.splice(Number(button.dataset.del), 1);
  if (!suite.cases.length) suite.cases.push({ q: "", a: "" });
  saveSuite();
  renderCases();
});
els.name.addEventListener("input", () => {
  suite.name = els.name.value;
  saveSuite();
});
$("#add-case").addEventListener("click", () => {
  suite.cases.push({ q: "", a: "" });
  saveSuite();
  renderCases();
  els.cases.querySelector<HTMLTextAreaElement>("textarea:last-of-type")?.focus();
});
$("#example").addEventListener("click", () => {
  suite = structuredClone(suite.lang === "js" ? CODE_EXAMPLE : EXAMPLE);
  saveSuite();
  fillEditor();
});

/* ------------------------------ import/export ---------------------------- */
$<HTMLInputElement>("#import").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    suite = parseSuite(await file.text());
    saveSuite();
    fillEditor();
    els.importError.classList.add("hidden");
  } catch (error) {
    els.importError.textContent = error instanceof Error ? error.message : "Invalid JSON.";
    els.importError.classList.remove("hidden");
  }
  (e.target as HTMLInputElement).value = "";
});
$("#export").addEventListener("click", () => {
  const blob = new Blob([suiteToJSON(suite)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${(suite.name || "benchmark").replace(/[^\w-]+/g, "-").toLowerCase()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

function fillEditor() {
  els.json.value = suiteToJSON(suite);
  els.name.value = suite.name;
  els.lang.value = suite.lang === "js" ? "js" : "text";
  els.task.value = suite.task || "";
  els.entry.value = suite.entry || DEFAULT_ENTRY;
  els.codeFields.classList.toggle("hidden", suite.lang !== "js");
  renderCases();
}

/* ------------------------------- copy/paste ------------------------------ */
function jsonStatus(message: string, ok = true) {
  els.jsonStatus.textContent = message;
  els.jsonStatus.className = `text-[10px] ${ok ? "text-emerald-400" : "text-red-400"}`;
}
$("#copy-json").addEventListener("click", async () => {
  els.json.value = suiteToJSON(suite);
  try {
    await navigator.clipboard.writeText(els.json.value);
    jsonStatus("Copied to clipboard.");
  } catch {
    // Clipboard permission denied (or an insecure origin): select it instead.
    els.json.select();
    jsonStatus("Press Ctrl/Cmd + C to copy.", false);
  }
});
$("#apply-json").addEventListener("click", () => {
  try {
    suite = parseSuite(els.json.value);
    saveSuite();
    fillEditor();
    jsonStatus(`Loaded ${suite.cases.length} cases.`);
  } catch (error) {
    jsonStatus(error instanceof Error ? error.message : "Invalid JSON.", false);
  }
});

els.lang.addEventListener("change", () => {
  suite.lang = els.lang.value === "js" ? "js" : "text";
  if (suite.lang === "js") suite.entry = suite.entry || DEFAULT_ENTRY;
  saveSuite();
  fillEditor();
});
els.task.addEventListener("input", () => {
  suite.task = els.task.value;
  saveSuite();
});
els.entry.addEventListener("input", () => {
  suite.entry = els.entry.value.trim() || DEFAULT_ENTRY;
  saveSuite();
});

/* -------------------------------- models -------------------------------- */
function savedModels(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(LS.models) || "[]");
    return Array.isArray(stored) ? stored.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}
const chosen = new Set(savedModels());

function renderModels() {
  const models = savedModels();
  if (!models.length) {
    els.models.innerHTML = `<p class="text-[12px] text-[var(--color-ink-faint)]">
      No models selected yet — <a href="/" class="text-[var(--color-accent)] underline underline-offset-2">choose them in the arena</a>.</p>`;
    return;
  }
  els.models.innerHTML = models
    .map((key) => {
      const { provider, id } = splitKey(key);
      const ready = isConfigured(provider);
      return `<label class="control-surface flex min-h-9 cursor-pointer items-center gap-2 px-2.5 text-[12px] ${ready ? "" : "opacity-50"}">
        <input type="checkbox" value="${esc(key)}" ${chosen.has(key) && ready ? "checked" : ""} ${ready ? "" : "disabled"} />
        <img src="${esc(PROVIDERS[provider]?.logo || "")}" alt="" class="size-4 object-contain ${PROVIDERS[provider]?.logoMonochrome ? "brightness-0 invert" : ""}" />
        <span class="truncate">${esc(id)}</span>
        ${ready ? "" : `<span class="ml-auto text-[10px] text-[var(--color-ink-faint)]">no key</span>`}
      </label>`;
    })
    .join("");
}
els.models.addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  box.checked ? chosen.add(box.value) : chosen.delete(box.value);
});

/* --------------------------------- runs ---------------------------------- */
function saveRun(finished: Run) {
  saveRuns([finished, ...loadRuns().filter((r) => r.ts !== finished.ts)]);
  renderRuns();
}
function renderRuns() {
  const all = loadRuns();
  els.runs.innerHTML = all
    .map(
      (r, i) => `<span class="control-surface flex min-h-8 items-center gap-1.5 pl-2.5 pr-1 text-[11px] ${run?.ts === r.ts ? "!border-[var(--color-accent)] text-[var(--color-accent)]" : ""}">
        <button data-run="${i}" class="flex items-center gap-1.5">
          <svg class="size-3.5"><use href="#i-history"></use></svg>
          <span>${esc(r.name?.trim() || r.suite.name || "Benchmark")}</span>
          <span class="text-[var(--color-ink-faint)]">${new Date(r.ts).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
        </button>
        <button data-del-run="${r.ts}" aria-label="Delete this benchmark run" title="delete"
          class="grid size-6 place-items-center rounded text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-red-400">
          <svg class="size-3"><use href="#i-trash"></use></svg>
        </button>
      </span>`,
    )
    .join("");
}
els.runs.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const remove = target.closest<HTMLElement>("[data-del-run]");
  if (remove) {
    const ts = Number(remove.dataset.delRun);
    if (!window.confirm("Delete this benchmark run?")) return;
    saveRuns(loadRuns().filter((r) => r.ts !== ts));
    if (run?.ts === ts) run = loadRuns()[0] || null;
    renderRuns();
    renderResults();
    return;
  }
  const open = target.closest<HTMLElement>("[data-run]");
  if (!open) return;
  run = loadRuns()[Number(open.dataset.run)] || null;
  renderRuns();
  renderResults();
});

/* ------------------------------- scoreboard ------------------------------ */
function renderResults() {
  if (!run) {
    els.results.innerHTML = `<div class="rounded-xl border border-dashed border-[var(--color-line)] px-4 py-10 text-center text-[12px] text-[var(--color-ink-faint)]">
      Write a few cases and run the benchmark to see the scoreboard.</div>`;
    return;
  }
  const cases = run.suite.cases;
  const scored = run.rows.map((row) => {
    const answered = row.cells.filter((c): c is Cell => !!c);
    const passed = answered.filter((c) => c.ok).length;
    return {
      ...row,
      passed,
      answered: answered.length,
      pct: answered.length ? (passed / cases.length) * 100 : 0,
      ms: answered.reduce((s, c) => s + c.ms, 0) / (answered.length || 1),
      cost: answered.reduce((s, c) => s + c.cost, 0),
    };
  });
  scored.sort((a, b) => b.passed - a.passed || a.ms - b.ms);

  const head = cases
    .map(
      (c, i) =>
        `<th class="w-8 px-1 text-center font-normal" title="${esc(c.q)} → ${esc(answerText(c.a))}">${i + 1}</th>`,
    )
    .join("");
  const body = scored
    .map((row) => {
      const { id } = splitKey(row.key);
      const cells = cases
        .map((_, i) => {
          const cell = row.cells[i];
          if (!cell)
            return `<td class="px-1 text-center text-[var(--color-ink-faint)]"><span class="inline-block size-2 animate-pulse rounded-full bg-[var(--color-line-hi)]"></span></td>`;
          const title = cell.error ? `error: ${cell.error}` : `answer: ${cell.answer || "(empty)"}`;
          return `<td class="px-1 text-center" title="${esc(title)}">
            <span class="${cell.ok ? "text-emerald-400" : "text-red-400/80"}">${cell.ok ? "✓" : "✗"}</span>
          </td>`;
        })
        .join("");
      return `<tr class="border-t border-[var(--color-line)]">
        <td class="max-w-[14rem] truncate py-1.5 pr-3 text-[12px] text-[var(--color-ink)]">${esc(id)}</td>
        <td class="w-32 py-1.5 pr-3">
          <div class="flex items-center gap-2">
            <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-line)]">
              <div class="h-full rounded-full bg-[var(--color-accent)]" style="width:${row.pct.toFixed(0)}%"></div>
            </div>
            <span class="w-14 shrink-0 text-right text-[11px] tabular-nums text-[var(--color-ink)]">${row.passed}/${cases.length}</span>
          </div>
        </td>
        ${cells}
        <td class="w-16 py-1.5 pl-3 text-right text-[11px] tabular-nums text-[var(--color-ink-dim)]">${fmtDur(row.ms)}</td>
        <td class="w-16 py-1.5 pl-3 text-right text-[11px] tabular-nums text-[var(--color-ink-dim)]">${fmtCost(row.cost)}</td>
      </tr>`;
    })
    .join("");
  const perCase = cases
    .map((_, i) => {
      const answered = run!.rows.map((r) => r.cells[i]).filter((c): c is Cell => !!c);
      const rate = answered.length ? answered.filter((c) => c.ok).length / answered.length : 0;
      return `<td class="px-1 text-center text-[10px] tabular-nums ${rate === 1 ? "text-emerald-400/70" : rate === 0 ? "text-red-400/60" : "text-[var(--color-ink-faint)]"}">${Math.round(rate * 100)}</td>`;
    })
    .join("");

  els.results.innerHTML = `
    <div class="panel-premium overflow-x-auto p-4 sm:p-5">
      <div class="flex flex-wrap items-baseline justify-between gap-2 pb-3">
        <h2 class="text-[13px] font-medium text-[var(--color-ink)]">${esc(run.suite.name || "Benchmark")}</h2>
        <p class="text-[11px] text-[var(--color-ink-faint)]">${cases.length} cases · ${run.rows.length} models · ${new Date(run.ts).toLocaleString()}</p>
      </div>
      <table class="w-full min-w-[34rem] text-[12px]">
        <thead class="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          <tr><th class="pb-2 text-left font-normal">Model</th><th class="pb-2 text-left font-normal">Score</th>${head}
          <th class="pb-2 pl-3 text-right font-normal">Avg</th><th class="pb-2 pl-3 text-right font-normal">Cost</th></tr>
        </thead>
        <tbody>${body}</tbody>
        <tfoot><tr class="border-t border-[var(--color-line)]">
          <td colspan="2" class="pt-2 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">% correct per case</td>
          ${perCase}<td colspan="2"></td>
        </tr></tfoot>
      </table>
    </div>`;
}

/* --------------------------------- runner -------------------------------- */
function setRunning(on: boolean) {
  els.runLabel.textContent = on ? "Stop" : "Run benchmark";
  els.run.classList.toggle("!bg-red-500/80", on);
}

async function runBenchmark() {
  if (controller) {
    controller.abort();
    controller = null;
    setRunning(false);
    return;
  }
  const cases = suite.cases.filter((c) => c.q.trim());
  const models = [...chosen].filter((key) => isConfigured(splitKey(key).provider));
  if (!cases.length || !models.length) {
    els.progress.textContent = !cases.length ? "Add at least one case." : "Select at least one model.";
    return;
  }

  const code = suite.lang === "js";
  controller = new AbortController();
  const { signal } = controller;
  setRunning(true);
  run = {
    ts: Date.now(),
    suite: { ...suite, name: suite.name || "Benchmark", cases },
    rows: models.map((key) => ({ key, cells: cases.map(() => null) })),
  };
  renderResults();

  let done = 0;
  // A code suite is one request per model — the program is written once and
  // then every case runs locally. A text suite is one request per case.
  const total = code ? models.length : models.length * cases.length;
  await Promise.all(
    run.rows.map(async (row) => {
      const { provider, id } = splitKey(row.key);
      const fail = (i: number, error: string) => {
        row.cells[i] = { ok: false, answer: "", error, ms: 0, cost: 0 };
      };

      if (code) {
        try {
          const reply = await chatOnce(provider, id, codeSystem(suite), taskPrompt(suite), signal);
          const source = extractAnswer(reply.text);
          const outcome = await runJs(source, suite.entry || DEFAULT_ENTRY, cases);
          cases.forEach((_, i) => {
            const result = outcome.results[i];
            row.cells[i] = {
              ok: result.ok,
              answer: result.got,
              ...(outcome.fatal ? { error: outcome.fatal } : {}),
              // The model is billed once; spread its latency and cost evenly.
              ms: reply.ms / cases.length,
              cost: reply.cost / cases.length,
            };
          });
        } catch (error) {
          if (signal.aborted) return;
          cases.forEach((_, i) =>
            fail(i, error instanceof Error ? error.message : String(error)),
          );
        }
        done++;
        els.progress.textContent = `${done} / ${total} programs`;
        renderResults();
        return;
      }

      // Models run in parallel, their own cases in sequence: one request per
      // provider at a time keeps rate limits out of the results.
      for (const [i, testCase] of cases.entries()) {
        if (signal.aborted) return;
        try {
          const reply = await chatOnce(provider, id, BENCH_SYSTEM, testCase.q, signal);
          const answer = extractAnswer(reply.text);
          row.cells[i] = {
            ok: grade(testCase.a, answer),
            answer,
            ms: reply.ms,
            cost: reply.cost,
          };
        } catch (error) {
          if (signal.aborted) return;
          fail(i, error instanceof Error ? error.message : String(error));
        }
        done++;
        els.progress.textContent = `${done} / ${total} answers`;
        renderResults();
      }
    }),
  );

  controller = null;
  setRunning(false);
  els.progress.textContent = signal.aborted
    ? "Stopped."
    : `Done — ${total} ${code ? "programs" : "answers"}.`;
  if (!signal.aborted) saveRun(run);
}

els.run.addEventListener("click", runBenchmark);

/* ---------------------------------- init --------------------------------- */
fillEditor();
renderModels();
run = loadRuns()[0] || null; // reopen on the last scoreboard, not on an empty one
renderRuns();
renderResults();
