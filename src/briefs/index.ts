/**
 * Briefs in, reports out — the two ends of the worker contract (§4.1, §4.2),
 * plus the reconciliation that decides whether to believe what comes back (DD-4).
 */

export { type Brief, type BriefContext, buildAnswerPrompt, buildBrief, buildTaskPrompt } from "./brief.js";
export { type ParsedReport, REPORT_RETRY_COUNT, REPORT_SCHEMA, findJsonObject, parseReport } from "./report.js";
export { type ReconcileInput, type TestVerification, matchesPath, normalizePath, reconcile } from "./reconcile.js";
