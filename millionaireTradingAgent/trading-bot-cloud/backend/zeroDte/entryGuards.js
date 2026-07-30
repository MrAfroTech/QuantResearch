/**
 * Returns true when minFloor is set and premium is below it.
 * minFloor null/undefined disables the check (placeholder until go-live).
 */
export function isPremiumBelowFloor(premium, minFloor) {
  if (minFloor == null || !Number.isFinite(Number(minFloor))) {
    return false;
  }
  const p = Number(premium);
  if (!Number.isFinite(p)) return false;
  return p < Number(minFloor);
}
