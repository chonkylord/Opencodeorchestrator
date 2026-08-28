/**
 * The unit under test in the golden repo.
 *
 * Small, dependency-free and genuinely exercised: the fixture's whole job is to
 * be a repository where `npm test` means something, so a worker that claims the
 * suite passes can be checked against a suite that really runs.
 */

export function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function mean(values) {
  if (values.length === 0) throw new RangeError("mean of an empty list is undefined");
  return sum(values) / values.length;
}

export function median(values) {
  if (values.length === 0) throw new RangeError("median of an empty list is undefined");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
