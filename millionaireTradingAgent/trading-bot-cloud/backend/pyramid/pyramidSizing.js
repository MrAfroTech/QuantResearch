import { PYRAMID_CONTRACTS, PYRAMID_TIER } from './pyramidConfig.js';

const SKIPPED = {
  quantity: 0,
  totalCost: 0,
  requiredCost: 0,
  legacyQty: 0,
  affordable: false,
  pyramidTier: null,
  entryContracts: 0,
};

/**
 * Tiered pyramid sizing at entry time (evaluated top-down):
 * 1. full (3 contracts) — perSlot >= 3 × contractCost
 * 2. partial (2 contracts) — perSlot >= 2 × contractCost
 * 3. legacy (1 contract) — perSlot >= 1 × contractCost; pre-pyramid exit logic at monitor
 * 4. skip — quantity 0, affordable false
 */
export function pyramidPositionSize(perSlot, premium) {
  const contractCost = premium * 100;
  if (!Number.isFinite(contractCost) || contractCost <= 0 || !Number.isFinite(perSlot) || perSlot <= 0) {
    return { ...SKIPPED, requiredCost: contractCost || 0 };
  }

  const legacyQty = Math.floor(perSlot / contractCost);

  if (perSlot >= PYRAMID_CONTRACTS * contractCost) {
    const quantity = PYRAMID_CONTRACTS;
    return {
      quantity,
      totalCost: quantity * contractCost,
      requiredCost: quantity * contractCost,
      legacyQty,
      affordable: true,
      pyramidTier: PYRAMID_TIER.FULL,
      entryContracts: quantity,
    };
  }

  if (perSlot >= 2 * contractCost) {
    const quantity = 2;
    return {
      quantity,
      totalCost: quantity * contractCost,
      requiredCost: quantity * contractCost,
      legacyQty,
      affordable: true,
      pyramidTier: PYRAMID_TIER.PARTIAL,
      entryContracts: quantity,
    };
  }

  if (perSlot >= contractCost) {
    return {
      quantity: 1,
      totalCost: contractCost,
      requiredCost: contractCost,
      legacyQty,
      affordable: true,
      pyramidTier: PYRAMID_TIER.LEGACY,
      entryContracts: 1,
    };
  }

  return {
    ...SKIPPED,
    requiredCost: contractCost,
    legacyQty,
  };
}
