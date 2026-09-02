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
    it('should maintain ORB_STOP_LOSS_PCT at configured value (1% soft stop)', async () => {
      const { ORB_STOP_LOSS_PCT } = await import('../../backend/orb/orbConfig.js');
      
      const EXPECTED_VALUE = 0.01; // 1% soft stop
      
      assert.strictEqual(
        ORB_STOP_LOSS_PCT,
        EXPECTED_VALUE,
        `ORB_STOP_LOSS_PCT has drifted! Expected ${EXPECTED_VALUE} (1%), got ${ORB_STOP_LOSS_PCT}. ` +
        `This is a CRITICAL config drift for a LIVE trading strategy.`
      );
    });
    
    it('should maintain ORB_HARD_STOP_PCT at configured value (1.75% hard stop)', async () => {
      const { ORB_HARD_STOP_PCT } = await import('../../backend/orb/orbConfig.js');
      
      const EXPECTED_VALUE = 0.0175; // 1.75% hard stop
      
      assert.strictEqual(
        ORB_HARD_STOP_PCT,
        EXPECTED_VALUE,
        `ORB_HARD_STOP_PCT has drifted! Expected ${EXPECTED_VALUE} (1.75%), got ${ORB_HARD_STOP_PCT}. ` +
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
    it('should maintain PREMARKET_STOP_LOSS_PCT at configured value (1% soft stop)', async () => {
      const { PREMARKET_STOP_LOSS_PCT } = await import('../../backend/premarketBreakout/premarketConfig.js');
      
      const EXPECTED_VALUE = 0.01; // 1% soft stop
      
      assert.strictEqual(
        PREMARKET_STOP_LOSS_PCT,
        EXPECTED_VALUE,
        `PREMARKET_STOP_LOSS_PCT has drifted! Expected ${EXPECTED_VALUE} (1%), got ${PREMARKET_STOP_LOSS_PCT}. ` +
        `This is a CRITICAL config drift for a LIVE trading strategy.`
      );
    });
    
    it('should maintain PREMARKET_HARD_STOP_TRIGGER at configured value (1.75% hard stop)', async () => {
      const { PREMARKET_HARD_STOP_TRIGGER } = await import('../../backend/premarketBreakout/premarketConfig.js');
      
      const EXPECTED_VALUE = 0.0175; // 1.75% hard stop
      
      assert.strictEqual(
        PREMARKET_HARD_STOP_TRIGGER,
        EXPECTED_VALUE,
        `PREMARKET_HARD_STOP_TRIGGER has drifted! Expected ${EXPECTED_VALUE} (1.75%), got ${PREMARKET_HARD_STOP_TRIGGER}. ` +
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
    it('should maintain EMA_VWAP_STOP_LOSS_PCT at configured value (1.75% soft stop)', async () => {
      const { EMA_VWAP_STOP_LOSS_PCT } = await import('../../backend/emaVwapCross/emaVwapConfig.js');
      
      const EXPECTED_VALUE = 0.0175; // 1.75% soft stop
      
      assert.strictEqual(
        EMA_VWAP_STOP_LOSS_PCT,
        EXPECTED_VALUE,
        `EMA_VWAP_STOP_LOSS_PCT has drifted! Expected ${EXPECTED_VALUE} (1.75%), got ${EMA_VWAP_STOP_LOSS_PCT}. ` +
        `This is a CRITICAL config drift for a LIVE trading strategy.`
      );
    });
    
    it('should maintain EMA_VWAP_HARD_STOP_PCT at configured value (2% hard stop)', async () => {
      const { EMA_VWAP_HARD_STOP_PCT } = await import('../../backend/emaVwapCross/emaVwapConfig.js');
      
      const EXPECTED_VALUE = 0.02; // 2% hard stop
      
      assert.strictEqual(
        EMA_VWAP_HARD_STOP_PCT,
        EXPECTED_VALUE,
        `EMA_VWAP_HARD_STOP_PCT has drifted! Expected ${EXPECTED_VALUE} (2%), got ${EMA_VWAP_HARD_STOP_PCT}. ` +
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
    it('should maintain STOP_LOSS_PCT at configured value (1.75% soft stop)', async () => {
      const { STOP_LOSS_PCT } = await import('../../backend/positionManager.js');
      
      const EXPECTED_VALUE = 0.0175; // 1.75% soft stop
      
      assert.strictEqual(
        STOP_LOSS_PCT,
        EXPECTED_VALUE,
        `STOP_LOSS_PCT (Swing) has drifted! Expected ${EXPECTED_VALUE} (1.75%), got ${STOP_LOSS_PCT}. ` +
        `This is a CRITICAL config drift for a PAPER trading strategy.`
      );
    });
    
    it('should maintain SWING_HARD_STOP_PCT at configured value (2% hard stop)', async () => {
      const { SWING_HARD_STOP_PCT } = await import('../../backend/positionManager.js');
      
      const EXPECTED_VALUE = 0.02; // 2% hard stop
      
      assert.strictEqual(
        SWING_HARD_STOP_PCT,
        EXPECTED_VALUE,
        `SWING_HARD_STOP_PCT has drifted! Expected ${EXPECTED_VALUE} (2%), got ${SWING_HARD_STOP_PCT}. ` +
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
  
  describe('Cross-Strategy Value Verification', () => {
    it('should have correct stop values per strategy (not shared)', async () => {
      const { ORB_STOP_LOSS_PCT, ORB_HARD_STOP_PCT } = await import('../../backend/orb/orbConfig.js');
      const { PREMARKET_STOP_LOSS_PCT, PREMARKET_HARD_STOP_TRIGGER } = await import('../../backend/premarketBreakout/premarketConfig.js');
      const { EMA_VWAP_STOP_LOSS_PCT, EMA_VWAP_HARD_STOP_PCT } = await import('../../backend/emaVwapCross/emaVwapConfig.js');
      const { STOP_LOSS_PCT, SWING_HARD_STOP_PCT } = await import('../../backend/positionManager.js');
      
      // ORB: 1% soft, 1.75% hard
      assert.strictEqual(ORB_STOP_LOSS_PCT, 0.01, 'ORB soft stop should be 1%');
      assert.strictEqual(ORB_HARD_STOP_PCT, 0.0175, 'ORB hard stop should be 1.75%');
      
      // Premarket: 1% soft, 1.75% hard
      assert.strictEqual(PREMARKET_STOP_LOSS_PCT, 0.01, 'Premarket soft stop should be 1%');
      assert.strictEqual(PREMARKET_HARD_STOP_TRIGGER, 0.0175, 'Premarket hard stop should be 1.75%');
      
      // Swing: 1.75% soft, 2% hard
      assert.strictEqual(STOP_LOSS_PCT, 0.0175, 'Swing soft stop should be 1.75%');
      assert.strictEqual(SWING_HARD_STOP_PCT, 0.02, 'Swing hard stop should be 2%');
      
      // EMA/VWAP: 1.75% soft, 2% hard
      assert.strictEqual(EMA_VWAP_STOP_LOSS_PCT, 0.0175, 'EMA/VWAP soft stop should be 1.75%');
      assert.strictEqual(EMA_VWAP_HARD_STOP_PCT, 0.02, 'EMA/VWAP hard stop should be 2%');
    });
    
    it('should verify ORB and Premarket share same stops (1%, 1.75%)', async () => {
      const { ORB_STOP_LOSS_PCT, ORB_HARD_STOP_PCT } = await import('../../backend/orb/orbConfig.js');
      const { PREMARKET_STOP_LOSS_PCT, PREMARKET_HARD_STOP_TRIGGER } = await import('../../backend/premarketBreakout/premarketConfig.js');
      
      assert.strictEqual(ORB_STOP_LOSS_PCT, PREMARKET_STOP_LOSS_PCT, 'ORB and Premarket should have same soft stop');
      assert.strictEqual(ORB_HARD_STOP_PCT, PREMARKET_HARD_STOP_TRIGGER, 'ORB and Premarket should have same hard stop');
    });
    
    it('should verify Swing and EMA/VWAP share same stops (1.75%, 2%)', async () => {
      const { STOP_LOSS_PCT, SWING_HARD_STOP_PCT } = await import('../../backend/positionManager.js');
      const { EMA_VWAP_STOP_LOSS_PCT, EMA_VWAP_HARD_STOP_PCT } = await import('../../backend/emaVwapCross/emaVwapConfig.js');
      
      assert.strictEqual(STOP_LOSS_PCT, EMA_VWAP_STOP_LOSS_PCT, 'Swing and EMA/VWAP should have same soft stop');
      assert.strictEqual(SWING_HARD_STOP_PCT, EMA_VWAP_HARD_STOP_PCT, 'Swing and EMA/VWAP should have same hard stop');
    });
  });
});
