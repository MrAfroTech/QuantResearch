/**
 * TEST 1: Config Drift Protection
 * 
 * Guards against silent changes to stop-loss configuration values.
 * These tests MUST fail loudly if any strategy's stop constants change from their configured values.
 * 
 * CRITICAL: This is the highest-priority test coverage given three of four strategies 
 * trade real capital (ORB, Premarket, EMA/VWAP live; Swing paper).
 * 
 * Current actual code values (as of test creation):
 * - ALL strategies: 10% (0.10) soft stop
 * - No separate hard stop configured (uses same value for poll-based monitoring)
 * 
 * NOTE: User documentation indicates expected values of:
 * - ORB/Premarket: 1% soft, 1.75% hard
 * - Swing/EMA-VWAP: 1.75% soft, 2% hard
 * However, actual code shows 10% for all. These tests verify the ACTUAL code state.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Config Drift Protection - Stop Loss Values', () => {
  
  describe('ORB Strategy', () => {
    it('should maintain ORB_STOP_LOSS_PCT at configured value', async () => {
      const { ORB_STOP_LOSS_PCT } = await import('../../backend/orb/orbConfig.js');
      
      const EXPECTED_VALUE = 0.10; // 10% - current actual value
      
      assert.strictEqual(
        ORB_STOP_LOSS_PCT,
        EXPECTED_VALUE,
        `ORB_STOP_LOSS_PCT has drifted! Expected ${EXPECTED_VALUE} (10%), got ${ORB_STOP_LOSS_PCT}. ` +
        `This is a CRITICAL config drift for a LIVE trading strategy.`
      );
    });
    
    it('should have ORB_STOP_LOSS_PCT as a number', async () => {
      const { ORB_STOP_LOSS_PCT } = await import('../../backend/orb/orbConfig.js');
      
      assert.strictEqual(
        typeof ORB_STOP_LOSS_PCT,
        'number',
        `ORB_STOP_LOSS_PCT must be a number, got ${typeof ORB_STOP_LOSS_PCT}`
      );
      
      assert.ok(
        Number.isFinite(ORB_STOP_LOSS_PCT),
        'ORB_STOP_LOSS_PCT must be a finite number'
      );
      
      assert.ok(
        ORB_STOP_LOSS_PCT > 0 && ORB_STOP_LOSS_PCT <= 1,
        `ORB_STOP_LOSS_PCT must be between 0 and 1 (percentage as decimal), got ${ORB_STOP_LOSS_PCT}`
      );
    });
  });
  
  describe('Premarket Strategy', () => {
    it('should maintain PREMARKET_STOP_LOSS_PCT at configured value', async () => {
      const { PREMARKET_STOP_LOSS_PCT } = await import('../../backend/premarketBreakout/premarketConfig.js');
      
      const EXPECTED_VALUE = 0.10; // 10% - current actual value
      
      assert.strictEqual(
        PREMARKET_STOP_LOSS_PCT,
        EXPECTED_VALUE,
        `PREMARKET_STOP_LOSS_PCT has drifted! Expected ${EXPECTED_VALUE} (10%), got ${PREMARKET_STOP_LOSS_PCT}. ` +
        `This is a CRITICAL config drift for a LIVE trading strategy.`
      );
    });
    
    it('should have PREMARKET_STOP_LOSS_PCT as a number', async () => {
      const { PREMARKET_STOP_LOSS_PCT } = await import('../../backend/premarketBreakout/premarketConfig.js');
      
      assert.strictEqual(
        typeof PREMARKET_STOP_LOSS_PCT,
        'number',
        `PREMARKET_STOP_LOSS_PCT must be a number, got ${typeof PREMARKET_STOP_LOSS_PCT}`
      );
      
      assert.ok(
        Number.isFinite(PREMARKET_STOP_LOSS_PCT),
        'PREMARKET_STOP_LOSS_PCT must be a finite number'
      );
      
      assert.ok(
        PREMARKET_STOP_LOSS_PCT > 0 && PREMARKET_STOP_LOSS_PCT <= 1,
        `PREMARKET_STOP_LOSS_PCT must be between 0 and 1 (percentage as decimal), got ${PREMARKET_STOP_LOSS_PCT}`
      );
    });
  });
  
  describe('EMA/VWAP Strategy', () => {
    it('should maintain EMA_VWAP_STOP_LOSS_PCT at configured value', async () => {
      const { EMA_VWAP_STOP_LOSS_PCT } = await import('../../backend/emaVwapCross/emaVwapConfig.js');
      
      const EXPECTED_VALUE = 0.10; // 10% - current actual value
      
      assert.strictEqual(
        EMA_VWAP_STOP_LOSS_PCT,
        EXPECTED_VALUE,
        `EMA_VWAP_STOP_LOSS_PCT has drifted! Expected ${EXPECTED_VALUE} (10%), got ${EMA_VWAP_STOP_LOSS_PCT}. ` +
        `This is a CRITICAL config drift for a LIVE trading strategy.`
      );
    });
    
    it('should have EMA_VWAP_STOP_LOSS_PCT as a number', async () => {
      const { EMA_VWAP_STOP_LOSS_PCT } = await import('../../backend/emaVwapCross/emaVwapConfig.js');
      
      assert.strictEqual(
        typeof EMA_VWAP_STOP_LOSS_PCT,
        'number',
        `EMA_VWAP_STOP_LOSS_PCT must be a number, got ${typeof EMA_VWAP_STOP_LOSS_PCT}`
      );
      
      assert.ok(
        Number.isFinite(EMA_VWAP_STOP_LOSS_PCT),
        'EMA_VWAP_STOP_LOSS_PCT must be a finite number'
      );
      
      assert.ok(
        EMA_VWAP_STOP_LOSS_PCT > 0 && EMA_VWAP_STOP_LOSS_PCT <= 1,
        `EMA_VWAP_STOP_LOSS_PCT must be between 0 and 1 (percentage as decimal), got ${EMA_VWAP_STOP_LOSS_PCT}`
      );
    });
  });
  
  describe('Swing Strategy', () => {
    it('should maintain STOP_LOSS_PCT at configured value', async () => {
      const { STOP_LOSS_PCT } = await import('../../backend/positionManager.js');
      
      const EXPECTED_VALUE = 0.10; // 10% - current actual value
      
      assert.strictEqual(
        STOP_LOSS_PCT,
        EXPECTED_VALUE,
        `STOP_LOSS_PCT (Swing) has drifted! Expected ${EXPECTED_VALUE} (10%), got ${STOP_LOSS_PCT}. ` +
        `This is a CRITICAL config drift for a PAPER trading strategy.`
      );
    });
    
    it('should have STOP_LOSS_PCT as a number', async () => {
      const { STOP_LOSS_PCT } = await import('../../backend/positionManager.js');
      
      assert.strictEqual(
        typeof STOP_LOSS_PCT,
        'number',
        `STOP_LOSS_PCT must be a number, got ${typeof STOP_LOSS_PCT}`
      );
      
      assert.ok(
        Number.isFinite(STOP_LOSS_PCT),
        'STOP_LOSS_PCT must be a finite number'
      );
      
      assert.ok(
        STOP_LOSS_PCT > 0 && STOP_LOSS_PCT <= 1,
        `STOP_LOSS_PCT must be between 0 and 1 (percentage as decimal), got ${STOP_LOSS_PCT}`
      );
    });
  });
  
  describe('Ladder Config (Shared Infrastructure)', () => {
    it('should maintain LADDER_INITIAL_STOP_PCT at configured value', async () => {
      const { LADDER_INITIAL_STOP_PCT } = await import('../../backend/ladder/ladderConfig.js');
      
      const EXPECTED_VALUE = 0.10; // 10% - current actual value
      
      assert.strictEqual(
        LADDER_INITIAL_STOP_PCT,
        EXPECTED_VALUE,
        `LADDER_INITIAL_STOP_PCT has drifted! Expected ${EXPECTED_VALUE} (10%), got ${LADDER_INITIAL_STOP_PCT}. ` +
        `This affects ALL strategies using ladder exit logic.`
      );
    });
  });
  
  describe('Cross-Strategy Consistency', () => {
    it('should have matching stop values across all strategies (current state)', async () => {
      const { ORB_STOP_LOSS_PCT } = await import('../../backend/orb/orbConfig.js');
      const { PREMARKET_STOP_LOSS_PCT } = await import('../../backend/premarketBreakout/premarketConfig.js');
      const { EMA_VWAP_STOP_LOSS_PCT } = await import('../../backend/emaVwapCross/emaVwapConfig.js');
      const { STOP_LOSS_PCT } = await import('../../backend/positionManager.js');
      const { LADDER_INITIAL_STOP_PCT } = await import('../../backend/ladder/ladderConfig.js');
      
      // Currently all strategies use the same 10% value
      const allValues = [
        ORB_STOP_LOSS_PCT,
        PREMARKET_STOP_LOSS_PCT,
        EMA_VWAP_STOP_LOSS_PCT,
        STOP_LOSS_PCT,
        LADDER_INITIAL_STOP_PCT
      ];
      
      const uniqueValues = [...new Set(allValues)];
      
      assert.strictEqual(
        uniqueValues.length,
        1,
        `Expected all strategies to have same stop value (current state), but found ${uniqueValues.length} different values: ${uniqueValues.join(', ')}`
      );
      
      assert.strictEqual(
        uniqueValues[0],
        0.10,
        'All strategies should currently use 0.10 (10%)'
      );
    });
  });
});
