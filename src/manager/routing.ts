/**
 * Which model runs a worker (`projectplan.md` §11 Phase 8, DD-9, §15).
 *
 * Until Phase 8 this was one line — `spec.model ?? models[mode] ?? default` —
 * and that was the right amount of machinery, because for seven phases there was
 * only ever one model configured. §15 deferred two things out of v1 that both
 * live here: *automatic model selection* and *cross-model adversarial review as
 * a default rather than an option*.
 *
 * **The fact that unblocked both was measured, not assumed.** Phases 6 and 7 both
 * state that every worker runs the same model, and ADR-0005 leans on it — "Phase
 * 6's reviewer is Muse Spark reviewing Muse Spark". That was true of the
 * *configuration*, not of the provider: `GET /provider` lists **six** models on
 * `opencode`, and on 2026-08-30 all six completed a turn on this key in
 * 1.0–5.8 s. So a reviewer can be a genuinely different model, and the caveat
 * ADR-0005 attached to every critique stops being unavoidable.
 *
 * Two things this deliberately is **not**:
 *
 * - **It does not classify the task text.** §15 says "automatic model selection
 *   based on task classification", and the honest classifier available here is
 *   the *mode*, which Claude states explicitly. Guessing a category out of a
 *   one-line task description would route work to the wrong model silently, and
 *   the only way to do it properly is a model call — a dependency the
 *   orchestrator has never taken and should not take for a routing hint.
 * - **It is not random.** A reviewer is picked deterministically, because a
 *   system whose whole value is evidence should produce the same route twice for
 *   the same inputs. "Which model reviewed this?" must have an answer that does
 *   not depend on when you asked.
 */

import type { WorkerMode } from "./types.js";

export interface RoutingConfig {
  /** DD-9's fallback, for anything no rule matches. */
  readonly defaultModel: string;
  /** Per-mode presets. Existing configuration; Phase 8 only adds callers. */
  readonly perMode?: Partial<Record<WorkerMode, string>>;
  /**
   * Models a `review` worker may be routed to, in preference order.
   *
   * Empty means "no pool configured", which is not the same as "no diversity":
   * a `review` preset that differs from the author still gives a cross-model
   * review. The pool exists for the case with several models available and no
   * wish to nominate one, which is the ordinary case now that there are six.
   */
  readonly reviewPool?: readonly string[];
}

export interface RouteRequest {
  readonly mode: WorkerMode;
  /** `spec.model`. Always wins: Claude asking for a model is not a hint. */
  readonly explicit?: string;
  /**
   * The model to route *away* from — the author's, when this is a review.
   *
   * Absent for everything else. Its presence is what turns this from a lookup
   * into a choice.
   */
  readonly avoid?: string;
}

export interface Route {
  readonly model: string;
  /** Why this model, in one machine-readable word. Lands in the audit trail. */
  readonly reason: "explicit" | "review_diversity" | "mode_preset" | "default";
  /**
   * Set only for a review worker: whether it ended up on a different model from
   * the work it is reviewing.
   *
   * `false` is not a failure and is not hidden — it is the caveat ADR-0005
   * wrote out in full, and a same-model review is weaker evidence that Claude
   * should be told about rather than left to infer.
   */
  readonly diverse?: boolean;
  /** The author's model, when this was a review. For the record. */
  readonly avoided?: string;
}

/**
 * Pick the model for one worker.
 *
 * Precedence, highest first:
 *
 * 1. **`spec.model`** — Claude named one. Nothing here second-guesses that, not
 *    even for review diversity: an explicit request to review with the author's
 *    own model is a legitimate thing to want (comparing two runs of one model is
 *    a real experiment) and silently overriding it would make the parameter a
 *    suggestion.
 * 2. **Review diversity** — a reviewer with a known author model takes the first
 *    candidate that differs from it.
 * 3. **The mode preset**, then **the default**.
 */
export function route(config: RoutingConfig, req: RouteRequest): Route {
  const perMode = config.perMode ?? {};
  const preset = perMode[req.mode];

  if (req.explicit) {
    return {
      model: req.explicit,
      reason: "explicit",
      ...(req.avoid === undefined ? {} : { diverse: req.explicit !== req.avoid, avoided: req.avoid }),
    };
  }

  if (req.mode === "review" && req.avoid) {
    // The pool first, then the review preset, then the default — every
    // configured way of naming a model, in the order of how deliberately it was
    // named, filtered to the ones that are not the author's.
    const candidates = [...(config.reviewPool ?? []), ...(preset ? [preset] : []), config.defaultModel];
    const different = candidates.find((m) => m !== req.avoid);
    if (different) return { model: different, reason: "review_diversity", diverse: true, avoided: req.avoid };
    // Everything available is the author's own model. Fall through and say so
    // rather than pretending: `diverse: false` is what makes the weaker evidence
    // visible in the result instead of only in the reader's assumptions.
    return { model: preset ?? config.defaultModel, reason: preset ? "mode_preset" : "default", diverse: false, avoided: req.avoid };
  }

  if (preset) return { model: preset, reason: "mode_preset" };
  return { model: config.defaultModel, reason: "default" };
}

/**
 * Parse a comma-separated model pool from configuration.
 *
 * Tolerant on purpose: a trailing comma or a stray space in an environment
 * variable should cost nothing, for the same reason every other value in
 * `config.ts` is clamped rather than validated — a server that will not start
 * because of a typo is worse than one that starts with a shorter pool.
 */
export function parseModelPool(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
}
