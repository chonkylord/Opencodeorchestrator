/**
 * The paginated unified diff (§7's `worker_diff`, §8's 400-line cap).
 *
 * §7 listed this tool from the start and Phase 3 deliberately did not build it:
 * the reader belongs beside the other git plumbing rather than in the MCP layer,
 * and nothing needed it until a human — or a `review` worker — had to decide
 * whether to accept a merge. Phase 4 needs it for exactly that.
 *
 * Three properties, in order of how expensive they are to get wrong:
 *
 * **1. It is untrusted text (DD-8).** A diff is a rendering of files a model
 * wrote after reading a repository that may contain anything. So every line is
 * length-capped here, the page is line-capped here, and the caller is told which
 * of the two happened. A cap enforced at the tool layer is a cap that the next
 * caller of this module forgets.
 *
 * **2. It paginates by line, not by file.** §8 says "full diff on demand with a
 * 400-line cap", and a 400-line cap that rounds up to whole files is not a cap —
 * one 12,000-line generated file would blow the context budget the cap exists to
 * defend. The cursor is a line offset into the diff, and a page may begin and
 * end mid-hunk. The header on each page says which lines it is, so a model can
 * tell a truncated hunk from a small one.
 *
 * **3. It reads the worker's tree, never the user's.** Every function here takes
 * a worktree path and a base sha, and runs read-only git in that worktree. It
 * does not check anything out, does not touch the index, and does not care what
 * branch the user has open.
 *
 * Untracked files are included, via `git diff --no-index` against `/dev/null`,
 * because a worker that has not been snapshotted yet has all of its new files
 * untracked and a diff that silently omits them reads as a worker that wrote
 * nothing. `changedFiles` makes the same allowance for the same reason.
 */

import { git } from "./git.js";
import { ORCHESTRATOR_DIR, REPORT_FILE } from "./worktree.js";

/** §8's number. The default page and the hard ceiling on one. */
export const DIFF_LINES_DEFAULT = 400;
export const DIFF_LINES_MAX = 1_000;
/** One line of a diff. Long enough for real code, short enough to bound a page. */
export const DIFF_LINE_CHARS = 500;
/**
 * How much diff is read into memory before paging it.
 *
 * A worker that commits a 200MB vendored bundle should cost a truncated page,
 * not the manager's heap.
 */
export const DIFF_BYTES_MAX = 8 * 1024 * 1024;
/** Untracked files rendered per call. Beyond this they are named, not shown. */
const UNTRACKED_MAX = 50;

const EXCLUDED = [ORCHESTRATOR_DIR, REPORT_FILE];
const EXCLUDE_PATHSPECS = EXCLUDED.map((p) => `:(exclude)${p}`);

export interface DiffOptions {
  /** Commit to diff against — the worker's `baseSha`. */
  readonly baseSha: string;
  /** Restrict to these repo-relative paths or globs. Empty means everything. */
  readonly paths?: readonly string[];
  /** Line offset to resume at, from a previous page's `nextCursor`. */
  readonly cursor?: number;
  /** Lines in this page. Default {@link DIFF_LINES_DEFAULT}, hard cap {@link DIFF_LINES_MAX}. */
  readonly maxLines?: number;
}

export interface DiffPage {
  /** The page itself, already line-capped and length-capped. */
  readonly lines: readonly string[];
  /** Line offset of the first line in `lines`. */
  readonly from: number;
  /** Total lines in the whole diff, so a caller can see what it is missing. */
  readonly totalLines: number;
  readonly hasMore: boolean;
  /** Pass as `cursor` for the next page. Absent when there is none. */
  readonly nextCursor?: number;
  /** How many lines were clipped to {@link DIFF_LINE_CHARS} on this page. */
  readonly clippedLines: number;
  /** Set when the whole diff was cut at {@link DIFF_BYTES_MAX} before paging. */
  readonly truncatedAtBytes?: boolean;
  /** Untracked files present but not rendered, because there were too many. */
  readonly untrackedOmitted: readonly string[];
}

/**
 * One page of the unified diff between `baseSha` and the worktree's current
 * state, tracked changes and untracked files together.
 *
 * The diff is regenerated on every call rather than cached. For a settled worker
 * the tree is not moving, so paging is stable; for a running one it is not, and
 * that is the honest answer — a cached diff of a tree that has since changed is
 * a page that describes a repository that no longer exists.
 */
export async function readDiff(worktree: string, opts: DiffOptions): Promise<DiffPage> {
  const maxLines = Math.min(Math.max(1, opts.maxLines ?? DIFF_LINES_DEFAULT), DIFF_LINES_MAX);
  const cursor = Math.max(0, opts.cursor ?? 0);
  const pathspecs = buildPathspecs(opts.paths);

  const tracked = await git(worktree, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    // Rename detection off: it makes a diff shorter to read and a page harder to
    // reason about, because a renamed file's content stops appearing at all.
    "--no-renames",
    opts.baseSha,
    "--",
    ...pathspecs,
  ]);

  const untracked = await listUntracked(worktree, pathspecs);
  const shown = untracked.slice(0, UNTRACKED_MAX);
  const parts: string[] = [tracked.stdout];
  for (const file of shown) parts.push(await diffUntracked(worktree, file));

  let text = parts.join("");
  let truncatedAtBytes = false;
  if (text.length > DIFF_BYTES_MAX) {
    text = `${text.slice(0, DIFF_BYTES_MAX)}\n…[diff truncated: over ${DIFF_BYTES_MAX} bytes]\n`;
    truncatedAtBytes = true;
  }

  const all = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const slice = all.slice(cursor, cursor + maxLines);
  let clipped = 0;
  const lines = slice.map((l) => {
    if (l.length <= DIFF_LINE_CHARS) return l;
    clipped++;
    return `${l.slice(0, DIFF_LINE_CHARS)}…[line clipped]`;
  });
  const end = cursor + lines.length;
  const hasMore = end < all.length;

  return {
    lines,
    from: cursor,
    totalLines: all.length,
    hasMore,
    ...(hasMore ? { nextCursor: end } : {}),
    clippedLines: clipped,
    ...(truncatedAtBytes ? { truncatedAtBytes: true } : {}),
    untrackedOmitted: untracked.slice(UNTRACKED_MAX),
  };
}

/**
 * The diff between two commits, for the merge pipeline's own reporting.
 *
 * Same caps, same shape; it just names two commits instead of a commit and a
 * worktree, which is what "show me what this merge actually brought in" needs.
 */
export async function readCommitDiff(
  repo: string,
  fromSha: string,
  toSha: string,
  opts: Omit<DiffOptions, "baseSha"> = {},
): Promise<DiffPage> {
  const maxLines = Math.min(Math.max(1, opts.maxLines ?? DIFF_LINES_DEFAULT), DIFF_LINES_MAX);
  const cursor = Math.max(0, opts.cursor ?? 0);
  const out = await git(repo, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    fromSha,
    toSha,
    "--",
    ...buildPathspecs(opts.paths),
  ]);
  const all = out.stdout === "" ? [] : out.stdout.replace(/\n$/, "").split("\n");
  const slice = all.slice(cursor, cursor + maxLines);
  let clipped = 0;
  const lines = slice.map((l) => {
    if (l.length <= DIFF_LINE_CHARS) return l;
    clipped++;
    return `${l.slice(0, DIFF_LINE_CHARS)}…[line clipped]`;
  });
  const end = cursor + lines.length;
  const hasMore = end < all.length;
  return {
    lines,
    from: cursor,
    totalLines: all.length,
    hasMore,
    ...(hasMore ? { nextCursor: end } : {}),
    clippedLines: clipped,
    untrackedOmitted: [],
  };
}

// ---------------------------------------------------------------------------

/**
 * Caller-supplied paths, plus the orchestrator's own exclusions.
 *
 * The exclusions are not optional and are not the caller's to drop:
 * `.orchestrator/` holds the worker manifest and the index, and a `worker_diff`
 * that renders them is showing Claude its own bookkeeping as if a worker had
 * written it.
 */
function buildPathspecs(paths: readonly string[] | undefined): string[] {
  const requested = (paths ?? []).filter((p) => p.trim() !== "" && !p.startsWith(":"));
  return [...(requested.length > 0 ? requested : ["."]), ...EXCLUDE_PATHSPECS];
}

async function listUntracked(worktree: string, pathspecs: readonly string[]): Promise<string[]> {
  const out = await git(worktree, ["ls-files", "--others", "--exclude-standard", "--", ...pathspecs]);
  return out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((f) => f !== "" && !EXCLUDED.some((p) => f === p || f.startsWith(`${p}/`)))
    .sort();
}

/**
 * A new file, rendered as a diff against nothing.
 *
 * `--no-index` compares two paths outside git's index, so it needs neither a
 * staging step nor a write of any kind — which is the point. It exits 1 when the
 * files differ, which for "file versus /dev/null" is always, so the failure is
 * expected rather than exceptional.
 */
async function diffUntracked(worktree: string, file: string): Promise<string> {
  // Relative path, run in the worktree: git echoes the path it was given, so
  // this keeps the untracked hunks repo-relative like the tracked ones and one
  // page reads as one diff.
  const out = await git(worktree, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file], {
    allowFailure: true,
  });
  return out.stdout;
}
