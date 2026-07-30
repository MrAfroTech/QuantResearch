import { LADDER_TARGET_CONTRACTS } from './ladderConfig.js';

/**
 * Ladder entry sizing: up to 5 contracts, as many as budget allows (minimum 1).
 * Skip only when zero contracts are affordable.
 */
export function ladderPositionSize(perSlot, premium) {
  const contractCost = premium * 100;
  if (!Number.isFinite(contractCost) || contractCost <= 0 || !Number.isFinite(perSlot) || perSlot <= 0) {
    return {
      quantity: 0,
      totalCost: 0,
      requiredCost: contractCost || 0,
      affordable: false,
      entryContracts: 0,
    };
  }

  const maxAffordable = Math.floor(perSlot / contractCost);
  if (maxAffordable < 1) {
    return {
      quantity: 0,
      totalCost: 0,
      requiredCost: contractCost,
      affordable: false,
      entryContracts: 0,
    };
  }

  const quantity = Math.min(LADDER_TARGET_CONTRACTS, maxAffordable);
  return {
    quantity,
    totalCost: quantity * contractCost,
    requiredCost: contractCost,
    affordable: true,
    entryContracts: quantity,
  };
}
