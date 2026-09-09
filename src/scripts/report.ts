/* /report — pick saved battles, get one compact, print-ready comparison
   report. Everything is local: history comes from localStorage and the PDF
   is whatever the browser prints. Blocks are packed into real A4 sheets so
   what you see on screen is what comes out of the printer. */
import {
  $,
  esc,
  fmtCost,
  fmtDur,
  fmtInt,
  loadHistory,
  saveHistory,
  type Battle,
  type HistoryResult,
} from "./lib";
import { loadRuns, saveRuns, type BenchCell, type BenchRun } from "./bench-core";

const history = loadHistory();
const runs = loadRuns();
const picker = $("#picker");
const out = $("#report");
const selected = new Set(history.map((b) => b.id || String(b.ts)));
const selectedRuns = new Set(runs.map((r) => r.ts));
const bid = (b: Battle) => b.id || String(b.ts);
const done = (b: Battle) => b.results.filter((r) => r.state === "done");
const tps = (r: HistoryResult) =>
  r.genMs && r.completionTokens ? (r.completionTokens / r.genMs) * 1000 : 0;
const day = (ts: number) =>
  new Date(ts).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const titleOf = (b: Battle, i: number) => b.name?.trim() || `Battle ${i + 1}`;
const modelOf = (key: string) => key.split("::").slice(1).join("::") || key;
const runTitle = (r: BenchRun) => r.name?.trim() || r.suite.name || "Benchmark";
const answers = (a: string | string[]) => (Array.isArray(a) ? a.join(" | ") : a);
const battleCost = (b: Battle) =>
  done(b).reduce((sum, r) => sum + (r.costKnown === false ? 0 : r.cost), 0);
const runCostOf = (r: BenchRun) =>
  r.rows.reduce(
    (sum, row) => sum + row.cells.reduce((s, cell) => s + (cell?.cost || 0), 0),
    0,
  );

/* Horizontal bars, inline SVG — no chart library for six rows of data. */
function chart(title: string, rows: [string, number][], fmt: (n: number) => string) {
  if (!rows.length) return "";
  const max = Math.max(...rows.map(([, v]) => v)) || 1;
  const h = 20;
  const body = rows
    .map(
      ([label, v], i) => `
      <text x="0" y="${i * h + 12}" class="c-lbl">${esc(label)}</text>
      <rect x="128" y="${i * h + 4}" width="${Math.max(1, (v / max) * 200)}" height="10" class="c-bar"/>
      <text x="336" y="${i * h + 12}" class="c-val">${esc(fmt(v))}</text>`,
    )
    .join("");
  return `<figure class="chart">
    <figcaption>${esc(title)}</figcaption>
    <svg viewBox="0 0 400 ${rows.length * h}" width="100%" height="${rows.length * h}">${body}</svg>
  </figure>`;
}

function table(rows: HistoryResult[]) {
  const min = (pick: (r: HistoryResult) => number) =>
    Math.min(...rows.filter((r) => pick(r) > 0).map(pick));
  const fastest = min((r) => r.durationMs);
  const cheapest = min((r) => (r.costKnown === false ? 0 : r.cost));
  return `<table>
    <thead><tr><th>Model</th><th>TTFT</th><th>Total</th><th>Tok/s</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
          <td class="m">${esc(r.label || r.id)}${r.state === "error" ? ` <span class="err">failed</span>` : ""}</td>
          <td class="n">${r.ttftMs ? fmtDur(r.ttftMs) : "—"}</td>
          <td class="n${r.durationMs === fastest ? " best" : ""}">${fmtDur(r.durationMs)}</td>
          <td class="n">${tps(r) ? tps(r).toFixed(1) : "—"}</td>
          <td class="n">${fmtInt(r.promptTokens)}</td>
          <td class="n">${fmtInt(r.completionTokens)}</td>
          <td class="n${r.cost === cheapest && r.costKnown !== false ? " best" : ""}">${fmtCost(r.cost, r.costKnown !== false)}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

/** HTML string → the elements it describes, so they can be measured. */
function blocks(html: string): HTMLElement[] {
  const host = document.createElement("div");
  host.innerHTML = html;
  return [...host.children] as HTMLElement[];
}

/* Pack blocks into A4 sheets: append one, and when the sheet overflows its
   content box the block starts the next one instead. A block taller than a
   whole sheet keeps its own page and simply runs over — dropping rows would
   be worse than a page that runs long. */
const PAGE_CONTENT_MM = 297 - 2 * 14; // A4 height minus the printed margins
function paginate(items: HTMLElement[]) {
  out.innerHTML = "";
  const limit = PAGE_CONTENT_MM * (96 / 25.4);
  const newPage = () => {
    const page = document.createElement("section");
    page.className = "page";
    const body = document.createElement("div");
    body.className = "page-body";
    page.append(body);
    out.append(page);
    return body;
  };
  let body = newPage();
  for (const item of items) {
    body.append(item);
    if (body.scrollHeight > limit && body.children.length > 1) {
      item.remove();
      body = newPage();
      body.append(item);
    }
  }
  const pages = [...out.children];
  pages.forEach((page, i) => {
    mergeChunks(page as HTMLElement);
    const foot = document.createElement("footer");
    foot.className = "page-foot";
    foot.textContent = `isbetter.ai · ${i + 1} / ${pages.length}`;
    page.append(foot);
  });
}

/* Long tables are emitted in chunks so pagination has somewhere to cut. Once
   the cuts are chosen, chunks that share a page are stitched back into one
   table — otherwise the header repeats mid-sheet, which reads as a new
   section. */
function mergeChunks(page: HTMLElement) {
  const chunks = [...page.querySelectorAll<HTMLElement>("[data-chunk]")];
  let host: HTMLElement | null = null;
  for (const chunk of chunks) {
    if (host && host.dataset.chunk === chunk.dataset.chunk) {
      const rows = chunk.querySelectorAll("tbody tr");
      host.querySelector("tbody")?.append(...rows);
      chunk.remove();
    } else {
      host = chunk;
    }
  }
}

/** One benchmark run: scoreboard, score bars and the questions behind them. */
function benchBlocks(runRecord: BenchRun): string {
  const cases = runRecord.suite.cases;
  const scored = runRecord.rows
    .map((row) => {
      const cells = row.cells.filter((c): c is BenchCell => !!c);
      return {
        name: modelOf(row.key),
        cells: row.cells,
        passed: cells.filter((c) => c.ok).length,
        ms: cells.reduce((sum, c) => sum + c.ms, 0) / (cells.length || 1),
        cost: cells.reduce((sum, c) => sum + c.cost, 0),
      };
    })
    .sort((a, b) => b.passed - a.passed || a.ms - b.ms);

  const runCost = scored.reduce((sum, row) => sum + row.cost, 0);
  const body = scored
    .map(
      (row) => `<tr>
        <td class="m">${esc(row.name)}</td>
        <td class="n">${row.passed}/${cases.length}</td>
        <td class="n">${Math.round((row.passed / (cases.length || 1)) * 100)}%</td>
        <td class="n">${fmtDur(row.ms)}</td>
        <td class="n">${fmtCost(row.cost)}</td>
      </tr>`,
    )
    .join("");

  /* One row per case with a column per model: a suite of forty questions
     grows down the page instead of off the right edge of the sheet. */
  const code = runRecord.suite.lang === "js";
  const CHUNK = 12;
  const caseTables = Array.from({ length: Math.ceil(cases.length / CHUNK) }, (_, page) => {
    const slice = cases.slice(page * CHUNK, page * CHUNK + CHUNK);
    return `<section class="block" data-chunk="cases-${runRecord.ts}">
      ${page === 0 ? `<h2>Cases</h2>` : ""}
      <table>
        <thead><tr><th class="tick">#</th><th class="lft">${code ? "Input" : "Question"}</th><th class="lft">Expected</th>
          ${scored.map((row) => `<th class="who" title="${esc(row.name)}">${esc(row.name.slice(0, 14))}</th>`).join("")}
        </tr></thead>
        <tbody>${slice
          .map((c, i) => {
            const index = page * CHUNK + i;
            return `<tr>
              <td class="tick dim">${index + 1}</td>
              <td class="m">${esc(c.q)}</td>
              <td class="m">${esc(answers(c.a))}</td>
              ${scored
                .map((row) => {
                  const cell = row.cells[index];
                  if (!cell) return `<td class="who dim">–</td>`;
                  if (cell.ok) return `<td class="who pass">✓</td>`;
                  // A failed case is only useful with what the model actually said.
                  const got = cell.error ? `error: ${cell.error}` : cell.answer || "(empty)";
                  return `<td class="who fail">✗ <span class="got">${esc(got.slice(0, 60))}</span></td>`;
                })
                .join("")}
            </tr>`;
          })
          .join("")}</tbody>
      </table>
    </section>`;
  }).join("");

  return `<section class="block">
      <h2>${esc(runTitle(runRecord))} <span class="meta">· benchmark · ${cases.length} cases · ${fmtCost(runCost)} · ${esc(day(runRecord.ts))}</span></h2>
      <table>
        <thead><tr><th>Model</th><th>Score</th><th>%</th><th>Avg</th><th>Cost</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot><tr><td class="m dim" colspan="4">Total</td><td class="n dim">${fmtCost(runCost)}</td></tr></tfoot>
      </table>
      <div class="charts">
        ${chart(
          "Score",
          scored.map((row) => [row.name, (row.passed / (cases.length || 1)) * 100] as [string, number]),
          (v) => `${Math.round(v)}%`,
        )}
        ${chart(
          "Average latency",
          scored.map((row) => [row.name, row.ms] as [string, number]),
          fmtDur,
        )}
      </div>
    </section>
    ${caseTables}`;
}

function render() {
  const battles = history.filter((b) => selected.has(bid(b)));
  const benchmarks = runs.filter((r) => selectedRuns.has(r.ts));
  if (!battles.length && !benchmarks.length) {
    out.innerHTML = `<p class="empty">Select at least one battle or benchmark.</p>`;
    return;
  }

  // Aggregate per model across every selected battle.
  const agg = new Map<
    string,
    { runs: number; ms: number; cost: number; tokens: number; tps: number }
  >();
  for (const b of battles)
    for (const r of done(b)) {
      const k = r.label || r.id;
      const a = agg.get(k) || { runs: 0, ms: 0, cost: 0, tokens: 0, tps: 0 };
      a.runs++;
      a.ms += r.durationMs;
      a.cost += r.costKnown === false ? 0 : r.cost;
      a.tokens += r.totalTokens;
      a.tps += tps(r);
      agg.set(k, a);
    }
  const models = [...agg.entries()].sort((a, b) => a[1].ms / a[1].runs - b[1].ms / b[1].runs);
  const totalCost = models.reduce((sum, [, a]) => sum + a.cost, 0);

  const benchCost = benchmarks.reduce((sum, r) => sum + runCostOf(r), 0);
  const summary = [
    battles.length ? `${battles.length} battle${battles.length > 1 ? "s" : ""} · ${fmtCost(totalCost)}` : "",
    benchmarks.length
      ? `${benchmarks.length} benchmark${benchmarks.length > 1 ? "s" : ""} · ${fmtCost(benchCost)}`
      : "",
    `${fmtCost(totalCost + benchCost)} spent in total`,
  ].filter(Boolean);

  paginate(
    blocks(`
    <header class="doc-head">
      <h1>Model comparison report</h1>
      <p class="meta">${esc(summary.join(" · "))} · generated ${esc(day(Date.now()))}</p>
    </header>
    ${
      !battles.length
        ? ""
        : `<section class="block">
      <h2>Overall</h2>
      <table>
        <thead><tr><th>Model</th><th>Runs</th><th>Avg total</th><th>Avg tok/s</th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>${models
          .map(
            ([name, a]) => `<tr>
              <td class="m">${esc(name)}</td>
              <td class="n">${a.runs}</td>
              <td class="n">${fmtDur(a.ms / a.runs)}</td>
              <td class="n">${(a.tps / a.runs).toFixed(1)}</td>
              <td class="n">${fmtInt(a.tokens)}</td>
              <td class="n">${fmtCost(a.cost)}</td>
            </tr>`,
          )
          .join("")}</tbody>
      </table>
      <div class="charts">
        ${chart(
          "Average response time",
          models.map(([n, a]) => [n, a.ms / a.runs] as [string, number]),
          fmtDur,
        )}
        ${chart(
          "Total cost",
          models.map(([n, a]) => [n, a.cost] as [string, number]),
          (v) => fmtCost(v),
        )}
      </div>
    </section>`
    }
    ${battles
      .map(
        (b, i) => `<article class="block">
          <h2>${esc(titleOf(b, i))} <span class="meta">· ${fmtCost(battleCost(b))} · ${esc(day(b.ts))}</span></h2>
          <p class="prompt">${b.prompt ? esc(b.prompt) : "(empty prompt)"}</p>
          ${table(b.results)}
        </article>`,
      )
      .join("")}
    ${benchmarks.map(benchBlocks).join("")}`),
  );
}

function renderPicker() {
  if (!history.length && !runs.length) {
    picker.innerHTML = `<p class="empty">Nothing saved yet. <a href="/">Run a battle</a> or a <a href="/bench">benchmark</a> first.</p>`;
    return;
  }
  const group = (label: string, rows: string) =>
    rows ? `<div class="pick-group"><p class="pick-head">${label}</p>${rows}</div>` : "";
  picker.innerHTML =
    group(
      "Battles",
      history
        .map(
          (b, i) => `<label class="pick">
        <input type="checkbox" data-kind="battle" value="${esc(bid(b))}" checked />
        <input class="name" data-name="${esc(bid(b))}" value="${esc(b.name || "")}" placeholder="Battle ${i + 1}" aria-label="Battle name" />
        <span>${esc((b.prompt || "(empty prompt)").slice(0, 60))}</span>
      </label>`,
        )
        .join(""),
    ) +
    group(
      "Benchmarks",
      runs
        .map(
          (r) => `<label class="pick">
        <input type="checkbox" data-kind="run" value="${r.ts}" checked />
        <input class="name" data-run-name="${r.ts}" value="${esc(r.name || "")}" placeholder="${esc(r.suite.name || "Benchmark")}" aria-label="Benchmark name" />
        <span>${r.suite.cases.length} cases · ${r.rows.length} models · ${esc(day(r.ts))}</span>
      </label>`,
        )
        .join(""),
    );
}

/** Battles are keyed by id, benchmark runs by timestamp. */
function toggle(box: HTMLInputElement, on: boolean) {
  if (box.dataset.kind === "run") {
    on ? selectedRuns.add(Number(box.value)) : selectedRuns.delete(Number(box.value));
  } else {
    on ? selected.add(box.value) : selected.delete(box.value);
  }
}

picker.addEventListener("change", (e) => {
  const cb = e.target as HTMLInputElement;
  if (cb.type !== "checkbox") return;
  toggle(cb, cb.checked);
  render();
});
picker.addEventListener("input", (e) => {
  const field = e.target as HTMLInputElement;
  const battleId = field.dataset.name;
  const runTs = field.dataset.runName;
  if (battleId) {
    const battle = history.find((b) => bid(b) === battleId);
    if (!battle) return;
    battle.name = field.value;
    saveHistory(history);
  } else if (runTs) {
    const record = runs.find((r) => r.ts === Number(runTs));
    if (!record) return;
    record.name = field.value;
    saveRuns(runs);
  } else return;
  render();
});

$("#print").addEventListener("click", () => window.print());
$("#all").addEventListener("click", () => {
  const boxes = [...picker.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const on = !boxes.every((box) => box.checked);
  boxes.forEach((box) => {
    box.checked = on;
    toggle(box, on);
  });
  render();
});

renderPicker();
render();
