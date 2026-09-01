/*
 * The dashboard client.
 *
 * Vanilla, deliberately — no framework, no build step, no CDN. The whole page is
 * three files served off a loopback socket, which is the only way it still works
 * six months from now with no toolchain to rot and on a laptop with no network.
 *
 * Two rules run through all of it:
 *
 * DD-8 — every string that came from a worker (its reply, its questions, its
 * summary, a tool title, a provider's error) is inserted with `textContent` or
 * `createTextNode`. There is not one `innerHTML` assignment carrying data in
 * this file. A worker reads a repository that may contain anything, and a
 * dashboard that renders that as markup is a stored-XSS hole aimed at the one
 * browser with the orchestrator's own origin open in it.
 *
 * DD-4 — a claim and a measurement never share a visual treatment. The worker's
 * own words get a light rule and a proportional face; the orchestrator's
 * measurements get a heavy rule and a monospace face; and the discrepancy
 * section says outright which one to believe.
 */

(() => {
  "use strict";

  // --------------------------------------------------------------- state

  /** @type {{server: any, workers: any[], runs: any[], merges: any[], totals: any}|null} */
  let snap = null;
  let selected = null;
  let tab = "activity";
  /** Detail payload for the selected worker: brief, spec, events, activity. */
  let detail = null;
  /** seq -> <div class="ent"> for the selected worker, so an open burst updates in place. */
  let entryEls = new Map();

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  };
  /** The only way text ever enters this document. */
  const txt = (node, s) => {
    node.textContent = s === undefined || s === null ? "" : String(s);
    return node;
  };

  // ---------------------------------------------------------- formatting

  const nf = new Intl.NumberFormat("en-US");

  function fmtNum(n) {
    if (!Number.isFinite(n)) return "0";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000) return `${Math.round(n / 1000)}k`;
    return nf.format(n);
  }

  function fmtDur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  }

  function fmtClock(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
      d.getSeconds(),
    ).padStart(2, "0")}`;
  }

  const ACTIVE = new Set(["spawned", "preparing", "running"]);
  const SETTLED = new Set(["completed", "merged"]);
  const BAD = new Set(["failed", "timed_out", "over_budget", "cancelled"]);

  /** Elapsed the way the tools compute it: queue time counts, and a settled worker stops. */
  function elapsed(w, now) {
    return (w.endedAt ?? now) - (w.startedAt ?? w.createdAt);
  }

  // ------------------------------------------------------------- glyphs
  //
  // State is shape, never colour. See the note at the top of app.css.

  const SVGNS = "http://www.w3.org/2000/svg";

  function glyph(state, queued, size) {
    const s = size ?? 12;
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("width", String(s));
    svg.setAttribute("height", String(s));
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("aria-hidden", "true");
    const add = (name, attrs) => {
      const n = document.createElementNS(SVGNS, name);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      svg.appendChild(n);
      return n;
    };
    const ink = "currentColor";
    if (state === "blocked") {
      // Half-filled: it has stopped, and half of it is waiting on you.
      add("circle", { cx: 6, cy: 6, r: 4.4, fill: "none", stroke: ink, "stroke-width": 1.4 });
      add("path", { d: "M6 1.6 A4.4 4.4 0 0 1 6 10.4 Z", fill: ink });
    } else if (queued) {
      // The one dashed ring that turns: the two live states are the two that
      // move, so a glance at a still frame is not the only way to read them.
      // Motion is decoration on top of the shape, never instead of it — see the
      // reduced-motion rule in app.css, which stops both and loses nothing.
      add("circle", {
        class: "g-queued",
        cx: 6,
        cy: 6,
        r: 4.2,
        fill: "none",
        stroke: ink,
        "stroke-width": 1.4,
        "stroke-dasharray": "2 2",
      });
    } else if (ACTIVE.has(state)) {
      add("circle", { class: "g-active", cx: 6, cy: 6, r: 4.2, fill: ink });
    } else if (SETTLED.has(state)) {
      add("rect", { x: 2, y: 2, width: 8, height: 8, fill: ink });
    } else if (state === "interrupted") {
      add("rect", { x: 2, y: 2, width: 8, height: 8, fill: "none", stroke: ink, "stroke-width": 1.4, "stroke-dasharray": "2 2" });
    } else if (BAD.has(state)) {
      add("path", { d: "M2.4 2.4 L9.6 9.6 M9.6 2.4 L2.4 9.6", stroke: ink, "stroke-width": 1.6, fill: "none" });
    } else {
      add("circle", { cx: 6, cy: 6, r: 4.2, fill: "none", stroke: ink, "stroke-width": 1.4 });
    }
    return svg;
  }

  // ------------------------------------------------------------- the graph

  const NODE_W = 162;
  const NODE_H = 62;
  const GAP_X = 16;
  const ROOT_H = 48;
  const ROOT_Y = 10;
  const ROW_Y = 122;
  /** Characters of 9.5px mono that fit inside a node's padding. Measured, not guessed. */
  const NODE_SUB_CHARS = 24;

  function drawGraph() {
    const svg = $("graph");
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!snap) return;

    // Stable order: spawn order, always. A graph whose nodes move when a state
    // changes is a graph you cannot watch, and watching is the entire point.
    const workers = [...snap.workers].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const now = Date.now();

    const totalW = Math.max(workers.length * NODE_W + (workers.length - 1) * GAP_X, 480);
    const width = totalW + 32;
    const height = workers.length > 0 ? ROW_Y + NODE_H + 34 : ROOT_Y + ROOT_H + 30;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", String(height));
    svg.style.minWidth = `${width}px`;

    const mk = (name, attrs, parent) => {
      const n = document.createElementNS(SVGNS, name);
      for (const [k, v] of Object.entries(attrs)) if (v !== undefined) n.setAttribute(k, String(v));
      (parent ?? svg).appendChild(n);
      return n;
    };

    // --- the orchestrator, at the top, because it is the thing delegating ---
    const rootW = 250;
    const rootX = (width - rootW) / 2;
    const rootG = mk("g", { class: "node" });
    mk("rect", { class: "n-box is-root", x: rootX, y: ROOT_Y, width: rootW, height: ROOT_H, rx: 2 }, rootG);
    txt(mk("text", { class: "n-title", x: rootX + 12, y: ROOT_Y + 20 }, rootG), "Claude · orchestrator");
    txt(
      mk("text", { class: "n-sub", x: rootX + 12, y: ROOT_Y + 36 }, rootG),
      `${snap.totals.running} running · ${snap.totals.queued} queued · ${snap.server.maxConcurrent} slots · ${fmtNum(
        snap.totals.tokens,
      )} tok`,
    );
    txt(mk("text", { class: "n-tag", x: rootX + rootW - 12, y: ROOT_Y + 20, "text-anchor": "end" }, rootG), snap.server.workspace);

    if (workers.length === 0) {
      txt(
        mk("text", { class: "n-sub", x: width / 2, y: ROOT_Y + ROOT_H + 22, "text-anchor": "middle" }),
        "no workers yet — spawn one and it appears here",
      );
      return;
    }

    const x0 = (width - totalW) / 2;
    const pos = new Map();
    workers.forEach((w, i) => pos.set(w.id, x0 + i * (NODE_W + GAP_X)));

    // --- edges first, so nodes paint over them ---
    const rootBottom = ROOT_Y + ROOT_H;
    for (const w of workers) {
      const x = pos.get(w.id) + NODE_W / 2;
      const live = ACTIVE.has(w.state) || w.state === "blocked";
      const mid = (rootBottom + ROW_Y) / 2;
      mk("path", {
        class: `edge${live ? " is-live" : ""}`,
        d: `M${width / 2} ${rootBottom} C ${width / 2} ${mid}, ${x} ${mid}, ${x} ${ROW_Y}`,
      });
    }

    // Dependency edges are a different relationship and are drawn as one:
    // dashed, below the row, so they never read as delegation.
    for (const w of workers) {
      for (const dep of w.dependsOn ?? []) {
        if (!pos.has(dep)) continue;
        const from = pos.get(dep) + NODE_W / 2;
        const to = pos.get(w.id) + NODE_W / 2;
        const y = ROW_Y + NODE_H;
        const dip = y + 18;
        mk("path", { class: "edge is-dep", d: `M${from} ${y} C ${from} ${dip}, ${to} ${dip}, ${to} ${y}` });
      }
    }

    // --- worker nodes ---
    const budget = Math.max(...workers.map((w) => w.totalTokens), 1);
    for (const w of workers) {
      const x = pos.get(w.id);
      const g = mk("g", { class: "node", tabindex: "0", role: "button" });
      g.addEventListener("click", () => select(w.id));
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select(w.id);
        }
      });
      const idle = !ACTIVE.has(w.state) && w.state !== "blocked";
      mk(
        "rect",
        {
          class: `n-box${idle ? " is-idle" : ""}${w.id === selected ? " is-sel" : ""}`,
          x,
          y: ROW_Y,
          width: NODE_W,
          height: NODE_H,
          rx: 2,
        },
        g,
      );

      const gl = glyph(w.state, Boolean(w.queue), 11);
      gl.setAttribute("x", String(x + 11));
      gl.setAttribute("y", String(ROW_Y + 11));
      g.appendChild(gl);

      txt(mk("text", { class: "n-title", x: x + 28, y: ROW_Y + 20 }, g), w.id);
      txt(mk("text", { class: "n-tag", x: x + NODE_W - 11, y: ROW_Y + 20, "text-anchor": "end" }, g), w.mode);
      // SVG text does not wrap and does not clip: a model name one character too
      // long simply draws over the next node. Both lines are cut to what fits.
      txt(mk("text", { class: "n-sub", x: x + 11, y: ROW_Y + 35 }, g), clip(w.model, NODE_SUB_CHARS));
      // Two anchors rather than one string: a state, an elapsed time and a token
      // count joined with separators is reliably one character too long for the
      // box, and the ellipsis always eats the number.
      txt(
        mk("text", { class: "n-sub", x: x + 11, y: ROW_Y + 48 }, g),
        clip(`${w.queue ? "queued" : w.state} · ${fmtDur(elapsed(w, now))}`, NODE_SUB_CHARS - 5),
      );
      txt(
        mk("text", { class: "n-sub", x: x + NODE_W - 11, y: ROW_Y + 48, "text-anchor": "end" }, g),
        fmtNum(w.totalTokens),
      );

      // Spend, to scale against the busiest worker. A measurement, drawn as one.
      const meterW = NODE_W - 22;
      mk("rect", { class: "n-meter-bg", x: x + 11, y: ROW_Y + NODE_H - 8, width: meterW, height: 2 }, g);
      mk(
        "rect",
        {
          class: "n-meter-fg",
          x: x + 11,
          y: ROW_Y + NODE_H - 8,
          width: Math.max(1, (meterW * w.totalTokens) / budget),
          height: 2,
        },
        g,
      );
      const title = document.createElementNS(SVGNS, "title");
      txt(title, `${w.id} — ${w.task}`);
      g.appendChild(title);
    }
  }

  function clip(s, n) {
    const t = String(s ?? "");
    return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
  }

  function drawLegend() {
    const box = $("legend");
    while (box.firstChild) box.removeChild(box.firstChild);
    const items = [
      ["running", "running", false],
      ["spawned", "queued", true],
      ["blocked", "blocked — wants an answer", false],
      ["completed", "settled", false],
      ["failed", "failed / stopped", false],
      ["interrupted", "session unreachable", false],
    ];
    for (const [state, label, queued] of items) {
      const s = el("span");
      s.appendChild(glyph(state, queued, 11));
      s.appendChild(document.createTextNode(label));
      box.appendChild(s);
    }
  }

  // -------------------------------------------------------- worker rows

  function drawRows() {
    const box = $("workers");
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!snap) return;
    const now = Date.now();

    // Attention first: a blocked worker is the one event worth waking for, and a
    // list sorted by id buries it under three that are running fine.
    const rank = (w) => (w.state === "blocked" ? 0 : w.orphaned ? 1 : ACTIVE.has(w.state) ? 2 : BAD.has(w.state) ? 3 : 4);
    const workers = [...snap.workers].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
    txt($("worker-count"), `${workers.length}`);

    if (workers.length === 0) {
      const p = el("p", "empty");
      txt(p, "No workers. Ask Claude to spawn one — worker_spawn — and it shows up here the moment it exists.");
      box.appendChild(p);
      return;
    }

    for (const w of workers) {
      const row = el("div", `row${w.id === selected ? " is-sel" : ""}`);
      row.addEventListener("click", () => select(w.id));

      const g = el("div", "row-glyph");
      g.appendChild(glyph(w.state, Boolean(w.queue), 12));
      row.appendChild(g);

      const main = el("div", "row-main");
      const top = el("div", "row-top");
      top.appendChild(txt(el("span", "row-id"), w.id));
      const state = el("span", "row-state");
      txt(state, w.queue ? "queued" : w.orphaned ? `${w.state} · unreachable` : w.state);
      top.appendChild(state);
      main.appendChild(top);

      main.appendChild(txt(el("div", "row-task"), w.task));

      const sub = el("div", "row-sub");
      // `shared` is the default and is already stated in the header; printing it
      // on every row spends the width that the exception needs.
      const bits = [w.mode, clip(w.model, 20)];
      if (w.workspace === "isolated") bits.push("isolated");
      if (w.revisions > 0) bits.push(`rev ${w.revisions}`);
      if (w.resumes > 0) bits.push(`res ${w.resumes}`);
      txt(sub, bits.join(" · "));
      main.appendChild(sub);
      row.appendChild(main);

      const right = el("div", "row-right");
      right.appendChild(txt(el("b"), fmtNum(w.totalTokens)));
      right.appendChild(document.createTextNode(fmtDur(elapsed(w, now))));
      row.appendChild(right);

      box.appendChild(row);
    }
  }

  // ------------------------------------------------------------- detail

  function currentWorker() {
    return snap && selected ? snap.workers.find((w) => w.id === selected) : undefined;
  }

  function drawDetailHead() {
    const w = currentWorker();
    const chip = $("d-state");
    if (!w) {
      txt($("d-id"), "no worker selected");
      chip.hidden = true;
      txt($("d-meta"), "");
      return;
    }
    txt($("d-id"), w.id);
    chip.hidden = false;
    chip.className = `chip${w.state === "blocked" || w.orphaned ? " is-hot" : ""}`;
    txt(chip, w.orphaned ? `${w.state} · unreachable` : w.queue ? "queued" : w.state);

    const meta = $("d-meta");
    while (meta.firstChild) meta.removeChild(meta.firstChild);
    const now = Date.now();
    const pairs = [
      ["mode", w.mode],
      ["model", w.model],
      ["run", w.runID],
      ["tree", w.workspace],
      ["elapsed", fmtDur(elapsed(w, now))],
      ["tokens", nf.format(w.totalTokens)],
      ["revisions", `${w.revisions}`],
      ["resumes", `${w.resumes}`],
    ];
    if (w.reason) pairs.push(["reason", w.reason]);
    if (w.ownedPaths.length > 0) pairs.push(["owns", w.ownedPaths.join(", ")]);
    if (w.dependsOn.length > 0) pairs.push(["after", w.dependsOn.join(", ")]);
    if (w.reviewOf) pairs.push(["reviews", w.reviewOf]);
    if (!w.structuredOutput) pairs.push(["schema", "unsupported by this model"]);
    for (const [k, v] of pairs) {
      const span = el("span");
      span.appendChild(txt(el("b"), k));
      span.appendChild(document.createTextNode(String(v)));
      meta.appendChild(span);
    }
  }

  function entryRow(e) {
    const row = el("div", `ent k-${e.kind}`);
    row.dataset.seq = String(e.seq);
    row.appendChild(txt(el("div", "ent-t"), fmtClock(e.at)));
    const kind = el("div", "ent-k");
    txt(kind, e.kind === "file" ? "edit" : e.kind);
    row.appendChild(kind);
    const body = el("div", "ent-b");
    if (e.kind === "tool") txt(body, e.tool ? `${e.tool}${e.text ? ` — ${e.text}` : ""}` : e.text);
    else if (e.kind === "file") txt(body, e.file ?? e.text);
    else txt(body, e.text);
    if (e.open) body.classList.add("caret");
    row.appendChild(body);
    return row;
  }

  function drawActivity(entries, replace) {
    const box = $("stream");
    if (replace) {
      while (box.firstChild) box.removeChild(box.firstChild);
      entryEls = new Map();
    }
    if (entries.length === 0 && box.childElementCount === 0) {
      const p = el("p", "empty");
      const w = currentWorker();
      txt(
        p,
        w && ACTIVE.has(w.state)
          ? "Waiting for the first frame from this worker."
          : "Nothing streamed for this worker. A worker from a previous orchestrator process has no live transcript — its audit trail is under Trail.",
      );
      box.appendChild(p);
      return;
    }
    const empty = box.querySelector(".empty");
    if (empty) empty.remove();

    for (const e of entries) {
      const existing = entryEls.get(e.seq);
      if (existing) {
        const body = existing.querySelector(".ent-b");
        txt(body, e.text);
        body.classList.toggle("caret", Boolean(e.open));
        continue;
      }
      // The previous burst is closed the moment anything follows it.
      for (const node of box.querySelectorAll(".ent-b.caret")) node.classList.remove("caret");
      const row = entryRow(e);
      entryEls.set(e.seq, row);
      box.appendChild(row);
    }

    // The ring upstream is bounded; so is the DOM, for the same reason.
    while (box.childElementCount > 600) {
      const first = box.firstElementChild;
      if (!first) break;
      entryEls.delete(Number(first.dataset.seq));
      first.remove();
    }

    if ($("follow").checked) {
      const stream = $("stream");
      stream.scrollTop = stream.scrollHeight;
    }
  }

  function drawTrail(events) {
    const box = $("trail");
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!events || events.length === 0) {
      const p = el("p", "empty");
      txt(p, "No lifecycle events recorded for this worker.");
      box.appendChild(p);
      return;
    }
    for (const ev of events) {
      const row = el("div", "tr");
      row.appendChild(txt(el("div", "tr-t"), fmtClock(ev.at)));
      row.appendChild(txt(el("div", "tr-k"), ev.kind));
      const detailText = Object.entries(ev.detail ?? {})
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("  ");
      row.appendChild(txt(el("div", "tr-d"), detailText));
      box.appendChild(row);
    }
  }

  function section(title) {
    const s = el("section", "sec");
    s.appendChild(txt(el("h3"), title));
    return s;
  }

  function drawResult() {
    const box = $("result");
    while (box.firstChild) box.removeChild(box.firstChild);
    const w = currentWorker();
    if (!w) return;

    if (w.state === "blocked") {
      const s = section("Blocked — it is waiting on an answer");
      for (const q of w.questions) s.appendChild(txt(el("div", "claim"), q));
      const p = el("p", "note");
      txt(
        p,
        w.orphaned
          ? "This worker's session died with a previous orchestrator process, so nothing can answer it. Ask Claude for worker_recover."
          : "Ask Claude to answer it — worker_message. The words above are the worker's own.",
      );
      s.appendChild(p);
      box.appendChild(s);
      return;
    }

    const r = w.result;
    if (!r) {
      const p = el("p", "empty");
      txt(p, `No result yet — ${w.state}.`);
      box.appendChild(p);
      return;
    }

    const claim = section("What the worker says it did — its own words, a claim");
    claim.appendChild(txt(el("div", "claim"), r.summary || "(no summary)"));
    box.appendChild(claim);

    const measured = section("What git and the test run say — measured");
    const dl = el("dl", "kv");
    const add = (k, v) => {
      dl.appendChild(txt(el("dt"), k));
      dl.appendChild(txt(el("dd"), v));
    };
    add("files changed", `${r.changes.files}`);
    add("lines", `+${r.changes.additions} / −${r.changes.deletions}`);
    add("duration", fmtDur(r.durationMs));
    add("tokens", nf.format(r.usage.totalTokens));
    add("report came from", r.reportSource);
    if (r.tests) add("tests", `${r.tests.passed ?? 0} passed, ${r.tests.failed ?? 0} failed, ${r.tests.skipped ?? 0} skipped`);
    if (r.snapshot) add("snapshot", r.snapshot.committed ? (r.snapshot.sha ?? "committed") : "not committed");
    if (r.review) add("review", `${r.review.of} by ${r.review.authorModel} — ${r.review.crossModel ? "cross-model" : "SAME model as the author"}`);
    measured.appendChild(dl);
    if (r.changes.paths.length > 0) {
      const ul = el("ul", "tight");
      for (const p of r.changes.paths) ul.appendChild(txt(el("li"), p));
      measured.appendChild(ul);
    }
    box.appendChild(measured);

    if (r.discrepancies.length > 0) {
      const s = section("Discrepancies — where the claim and the measurement disagree");
      for (const d of r.discrepancies) {
        const row = el("div", "measured");
        txt(row, `${d.kind}${d.file ? ` · ${d.file}` : ""} — ${d.detail}`);
        s.appendChild(row);
      }
      const p = el("p", "note");
      txt(p, "These are the finding. The summary above is the thing being contradicted.");
      s.appendChild(p);
      box.appendChild(s);
    }

    // Shared-mode only. ADR-0008's whole point is that attribution in a shared
    // tree is best-effort and must LOOK best-effort, so it gets its own section
    // rather than being folded into the measurements above.
    const a = r.attribution;
    if (a) {
      const s = section("Attribution — best-effort, because the tree is shared");
      const d2 = el("dl", "kv");
      const add2 = (k, v) => {
        d2.appendChild(txt(el("dt"), k));
        d2.appendChild(txt(el("dd"), v.length > 0 ? v.join(", ") : "—"));
      };
      add2("owned", a.owned);
      add2("unattributed", a.unattributed);
      add2("pre-existing (yours)", a.preexisting);
      add2("concurrent workers", a.concurrent);
      s.appendChild(d2);
      const p = el("p", "note");
      txt(p, "Anything unattributed could belong to another worker, or to you. A shared result with a long unattributed list is a weaker measurement than an isolated one.");
      s.appendChild(p);
      box.appendChild(s);
    }

    for (const [title, list] of [
      ["Risks — the worker's own words", r.risks],
      ["Follow-ups — the worker's own words", r.followUps],
      ["Open questions — the worker's own words", r.questions],
    ]) {
      if (!list || list.length === 0) continue;
      const s = section(title);
      const ul = el("ul", "tight");
      for (const item of list) ul.appendChild(txt(el("li"), item));
      s.appendChild(ul);
      box.appendChild(s);
    }
  }

  function drawBrief() {
    const pre = $("brief");
    if (!detail) return txt(pre, "");
    if (detail.brief) {
      txt(pre, `${detail.brief.system}\n\n─── this turn's instruction ───\n\n${detail.brief.text}`);
    } else {
      txt(
        pre,
        "No live brief. This worker is not running in the current orchestrator process, so the brief it was given is not in memory.\n\nThe spec it was built from:\n\n" +
          JSON.stringify(detail.spec, null, 2),
      );
    }
  }

  function drawDiff(page) {
    const pre = $("diff");
    while (pre.firstChild) pre.removeChild(pre.firstChild);
    if (!page || page.lines.length === 0) {
      const p = el("p", "empty");
      txt(p, "No changes measured for this worker.");
      pre.appendChild(p);
      return;
    }
    for (const line of page.lines) {
      const span = el(
        "span",
        line.startsWith("+") && !line.startsWith("+++")
          ? "add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "del"
            : line.startsWith("@@")
              ? "hunk"
              : "",
      );
      txt(span, `${line}\n`);
      pre.appendChild(span);
    }
    if (page.hasMore) {
      const p = el("p", "note");
      txt(p, `Showing ${page.lines.length} of ${page.totalLines} lines.`);
      pre.appendChild(p);
    }
  }

  // ---------------------------------------------------------- selection

  async function select(id) {
    selected = id;
    drawRows();
    drawGraph();
    drawDetailHead();
    await loadDetail();
  }

  async function loadDetail() {
    if (!selected) return;
    const id = selected;
    try {
      const res = await fetch(`/api/worker/${encodeURIComponent(id)}/detail`);
      if (!res.ok) return;
      const body = await res.json();
      if (selected !== id) return;
      detail = body;
      drawActivity(body.activity ?? [], true);
      drawTrail(body.events ?? []);
      drawResult();
      drawBrief();
    } catch {
      /* the stream will bring the page back into sync on its own */
    }
    if (tab === "diff") await loadDiff();
  }

  async function loadDiff() {
    if (!selected) return;
    const id = selected;
    txt($("diff"), "reading…");
    try {
      const res = await fetch(`/api/worker/${encodeURIComponent(id)}/diff`);
      const body = await res.json();
      if (selected !== id) return;
      if (body.error) return txt($("diff"), String(body.error));
      drawDiff(body.diff);
    } catch (e) {
      txt($("diff"), String(e));
    }
  }

  function showTab(next) {
    tab = next;
    for (const b of document.querySelectorAll(".tab")) b.classList.toggle("is-on", b.dataset.tab === next);
    for (const name of ["activity", "events", "result", "brief", "diff"]) {
      $(`p-${name}`).hidden = name !== next;
    }
    if (next === "diff") void loadDiff();
  }

  // ------------------------------------------------------------- header

  function drawHeader() {
    if (!snap) return;
    txt($("repo"), snap.server.repoRoot);
    txt($("s-running"), String(snap.totals.running));
    txt($("s-queued"), String(snap.totals.queued));
    txt($("s-blocked"), String(snap.totals.blocked));
    txt($("s-settled"), String(snap.totals.settled));
    txt($("s-failed"), String(snap.totals.failed));
    const cap = snap.server.runBudgetTokens;
    txt($("s-tokens"), cap > 0 ? `${fmtNum(snap.totals.tokens)}/${fmtNum(cap)}` : fmtNum(snap.totals.tokens));
    txt(
      $("graph-meta"),
      `${snap.server.defaultModel} · max ${snap.server.maxConcurrent} concurrent · wait cap ${Math.round(
        snap.server.waitMaxMs / 1000,
      )}s`,
    );
    document.title = snap.totals.blocked > 0 ? `(${snap.totals.blocked} blocked) orchestrator` : "orchestrator";
  }

  function redrawAll() {
    drawHeader();
    drawGraph();
    drawRows();
    drawDetailHead();
    drawResult();
  }

  // ------------------------------------------------------------- stream

  function connect() {
    const src = new EventSource("/api/stream");
    const setLink = (on, label) => {
      $("dot").classList.toggle("on", on);
      txt($("link-text"), label);
    };

    src.addEventListener("open", () => setLink(true, "live"));
    src.addEventListener("error", () => setLink(false, "reconnecting"));

    src.addEventListener("snapshot", (e) => {
      snap = JSON.parse(e.data);
      setLink(true, "live");
      if (selected && !snap.workers.some((w) => w.id === selected)) selected = null;
      redrawAll();
      if (selected) void loadDetail();
    });

    src.addEventListener("worker", (e) => {
      if (!snap) return;
      const view = JSON.parse(e.data);
      const i = snap.workers.findIndex((w) => w.id === view.id);
      if (i >= 0) snap.workers[i] = view;
      else snap.workers.push(view);
      recount();
      redrawAll();
    });

    src.addEventListener("event", (e) => {
      const ev = JSON.parse(e.data);
      if (ev.workerID !== selected || !detail) return;
      detail.events = [...(detail.events ?? []), ev];
      if (tab === "events") drawTrail(detail.events);
    });

    src.addEventListener("activity", (e) => {
      const entry = JSON.parse(e.data);
      if (snap) {
        const w = snap.workers.find((x) => x.id === entry.workerID);
        // Keep the row's event count honest without a round trip.
        if (w) w.activity = { ...w.activity, count: (w.activity?.count ?? 0) + (entry.open ? 0 : 1), last: entry };
      }
      if (entry.workerID === selected) drawActivity([entry], false);
    });
  }

  /** Recompute the header totals from the workers we hold, after an incremental update. */
  function recount() {
    let running = 0;
    let queued = 0;
    let blocked = 0;
    let settled = 0;
    let failed = 0;
    let tokens = 0;
    for (const w of snap.workers) {
      tokens += w.totalTokens;
      if (w.state === "blocked") blocked += 1;
      else if (w.state === "spawned" && w.queue) queued += 1;
      else if (ACTIVE.has(w.state)) running += 1;
      if (SETTLED.has(w.state) || BAD.has(w.state)) settled += 1;
      if (w.state === "failed" || w.state === "timed_out" || w.state === "over_budget") failed += 1;
    }
    snap.totals = { ...snap.totals, workers: snap.workers.length, running, queued, blocked, settled, failed, tokens };
  }

  // --------------------------------------------------------------- boot

  function boot() {
    const stored = localStorage.getItem("orch-theme");
    if (stored === "dark" || stored === "light") document.documentElement.dataset.theme = stored;
    else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) document.documentElement.dataset.theme = "dark";

    const themeBtn = $("theme");
    // Drawn rather than typed: `◐` is missing from enough default stacks to show
    // up as a tofu box, which is a poor advertisement for a design pass.
    themeBtn.appendChild(
      (() => {
        const svg = document.createElementNS(SVGNS, "svg");
        svg.setAttribute("width", "11");
        svg.setAttribute("height", "11");
        svg.setAttribute("viewBox", "0 0 12 12");
        svg.setAttribute("aria-hidden", "true");
        const ring = document.createElementNS(SVGNS, "circle");
        for (const [k, v] of Object.entries({ cx: 6, cy: 6, r: 4.6, fill: "none", stroke: "currentColor", "stroke-width": 1.3 })) {
          ring.setAttribute(k, String(v));
        }
        const half = document.createElementNS(SVGNS, "path");
        half.setAttribute("d", "M6 1.4 A4.6 4.6 0 0 1 6 10.6 Z");
        half.setAttribute("fill", "currentColor");
        svg.append(ring, half);
        return svg;
      })(),
    );
    themeBtn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("orch-theme", next);
    });

    for (const b of document.querySelectorAll(".tab")) {
      b.addEventListener("click", () => showTab(b.dataset.tab));
    }

    drawLegend();
    connect();
    // Elapsed times move even when nothing else does. Cheap, and the difference
    // between a dashboard and a screenshot.
    setInterval(() => {
      if (!snap) return;
      drawRows();
      drawGraph();
      drawDetailHead();
    }, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
