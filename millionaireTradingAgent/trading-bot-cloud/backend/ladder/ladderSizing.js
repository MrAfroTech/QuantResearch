import {
  LADDER_TARGET_CONTRACTS,
  OPTION_OPENING_COMMISSION_PER_CONTRACT,
} from './ladderConfig.js';

export { OPTION_OPENING_COMMISSION_PER_CONTRACT };

/**
 * Cash required to open one contract: premium × 100 + opening commission.
 * Always floor later — never round this cost down.
 */
export function contractEntryCost(premium, feePerContract = 0) {
  const notional = Number(premium) * 100;
  const fee = Number(feePerContract);
  if (!Number.isFinite(notional) || notional <= 0) return 0;
  return notional + (Number.isFinite(fee) && fee > 0 ? fee : 0);
}

/**
 * Max whole contracts that fit `budgetAvailable` at `premium`.
 * Always Math.floor — never rounds up.
 */
export function maxAffordableContracts(budgetAvailable, premium, feePerContract = 0) {
  const contractCost = contractEntryCost(premium, feePerContract);
  if (
    !Number.isFinite(contractCost) ||
    contractCost <= 0 ||
    !Number.isFinite(budgetAvailable) ||
    budgetAvailable <= 0
  ) {
    return 0;
  }
  return Math.floor(budgetAvailable / contractCost);
}

/**
 * Ladder entry sizing.
 *
 * Default (Swing): cap at LADDER_TARGET_CONTRACTS.
 * EMA/VWAP: pass EMA_VWAP_ENTRY_SIZING from emaVwapConfig.js (hard 1-contract cap).
 * Premarket: pass PREMARKET_ENTRY_SIZING from premarketConfig.js (hard 1-contract cap).
 * ORB: pass ORB_ENTRY_SIZING from orbConfig.js (hard 1-contract cap override).
 *
 * Skip (quantity 0) when even 1 contract is unaffordable — do not enter.
 *
 * FCFS budget model: `budgetAvailable` is already remaining-after-constraints.
 */
export function ladderPositionSize(budgetAvailable, premium, options = {}) {
  const maxContracts =
    options.maxContracts === undefined ? LADDER_TARGET_CONTRACTS : options.maxContracts;
  const feePerContract = options.feePerContract ?? 0;
  const contractCost = contractEntryCost(premium, feePerContract);

  if (
    !Number.isFinite(contractCost) ||
    contractCost <= 0 ||
    !Number.isFinite(budgetAvailable) ||
    budgetAvailable <= 0
  ) {
    return {
      quantity: 0,
      totalCost: 0,
      requiredCost: contractCost || 0,
      affordable: false,
      entryContracts: 0,
    };
  }

  const maxAffordable = maxAffordableContracts(budgetAvailable, premium, feePerContract);
  if (maxAffordable < 1) {
    return {
      quantity: 0,
      totalCost: 0,
      requiredCost: contractCost,
      affordable: false,
      entryContracts: 0,
    };
  }

  const cap = Number.isFinite(Number(maxContracts))
    ? Math.max(0, Math.floor(Number(maxContracts)))
    : maxAffordable;
  const quantity = Math.min(cap, maxAffordable);
  if (quantity < 1) {
    return {
      quantity: 0,
      totalCost: 0,
      requiredCost: contractCost,
      affordable: false,
      entryContracts: 0,
    };
  }

  return {
    quantity,
    totalCost: quantity * contractCost,
    requiredCost: contractCost,
    affordable: true,
    entryContracts: quantity,
  };
}

/**
 * Uncapped max-affordable helper (opening commission included).
 * Production Premarket no longer uses this — see PREMARKET_ENTRY_SIZING
 * in premarketConfig.js (hard 1-contract cap, reversible).
 */
export const ORB_PREMARKET_ENTRY_SIZING = Object.freeze({
  maxContracts: Infinity,
  feePerContract: OPTION_OPENING_COMMISSION_PER_CONTRACT,
});
