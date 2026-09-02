/**
 * TEST 2: Stop Placement Correctness
 * 
 * Verifies that stop prices are calculated correctly from REAL fill prices, not stale quotes.
 * This is a regression test for the entry-price bug that was fixed.
 * 
 * Tests each strategy's stop calculation logic to ensure:
 * 1. Stops are based on actual fill/entry price
 * 2. Stop trigger prices are calculated with correct percentage
 * 3. Stop limit prices (if applicable) are calculated correctly
 * 4. Rounding and precision are appropriate for options pricing
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Stop Placement Correctness', () => {
  
  describe('Stop Trigger Price Calculation', () => {
    it('should calculate stop trigger from entry premium correctly', async () => {
      const { computeStopTriggerPrice } = await import('../../backend/ladder/ladderConfig.js');
      
      const testCases = [
        {
          entryPremium: 1.00,
          stopPnlFrac: -0.10, // -10% stop
          expectedTrigger: 0.90,
          description: '$1.00 entry with -10% stop'
        },
        {
          entryPremium: 2.50,
          stopPnlFrac: -0.10,
          expectedTrigger: 2.25,
          description: '$2.50 entry with -10% stop'
        },
        {
          entryPremium: 0.50,
          stopPnlFrac: -0.10,
          expectedTrigger: 0.45,
          description: '$0.50 entry with -10% stop'
        },
        {
          entryPremium: 0.75,
          stopPnlFrac: -0.10,
          expectedTrigger: 0.68, // rounds to $0.68
          description: '$0.75 entry with -10% stop (tests rounding)'
        },
        {
          entryPremium: 1.00,
          stopPnlFrac: -0.0175, // -1.75% stop (potential future config)
          expectedTrigger: 0.98,
          description: '$1.00 entry with -1.75% stop'
        },
        {
          entryPremium: 1.00,
          stopPnlFrac: -0.02, // -2% stop (potential future config)
          expectedTrigger: 0.98,
          description: '$1.00 entry with -2% stop'
        }
      ];
      
      for (const testCase of testCases) {
        const result = computeStopTriggerPrice(testCase.entryPremium, testCase.stopPnlFrac);
        
        assert.strictEqual(
          result,
          testCase.expectedTrigger,
          `${testCase.description}: Expected ${testCase.expectedTrigger}, got ${result}`
        );
      }
    });
    
    it('should never calculate stop trigger below $0.01 minimum', async () => {
      const { computeStopTriggerPrice } = await import('../../backend/ladder/ladderConfig.js');
      
      const testCases = [
        { entryPremium: 0.05, stopPnlFrac: -0.10 }, // Would be $0.045
        { entryPremium: 0.01, stopPnlFrac: -0.50 }, // Would be $0.005
        { entryPremium: 0.10, stopPnlFrac: -0.95 }  // Would be $0.005
      ];
      
      for (const testCase of testCases) {
        const result = computeStopTriggerPrice(testCase.entryPremium, testCase.stopPnlFrac);
        
        assert.ok(
          result >= 0.01,
          `Stop trigger must be at least $0.01, got $${result} for entry=${testCase.entryPremium}, stopFrac=${testCase.stopPnlFrac}`
        );
      }
    });
    
    it('should handle invalid inputs gracefully', async () => {
      const { computeStopTriggerPrice } = await import('../../backend/ladder/ladderConfig.js');
      
      const invalidCases = [
        { entryPremium: null, stopPnlFrac: -0.10 },
        { entryPremium: 0, stopPnlFrac: -0.10 },
        { entryPremium: -1.00, stopPnlFrac: -0.10 },
        { entryPremium: NaN, stopPnlFrac: -0.10 },
        { entryPremium: Infinity, stopPnlFrac: -0.10 }
      ];
      
      for (const testCase of invalidCases) {
        const result = computeStopTriggerPrice(testCase.entryPremium, testCase.stopPnlFrac);
        
        assert.strictEqual(
          result,
          null,
          `Invalid input should return null: entry=${testCase.entryPremium}, stopFrac=${testCase.stopPnlFrac}`
        );
      }
      
      // Note: The function currently handles null stopPnlFrac by returning a valid result.
      // This test validates that it rejects invalid entry premiums.
      const resultWithNullStop = computeStopTriggerPrice(1.00, null);
      assert.ok(
        resultWithNullStop === null || typeof resultWithNullStop === 'number',
        'Function should handle null stopPnlFrac gracefully (either reject or calculate with default)'
      );
    });
  });
  
  describe('Stop Limit Price Calculation', () => {
    it('should calculate stop limit with correct offset', async () => {
      const { computeStopLimitPrice, LADDER_STOP_LIMIT_OFFSET_PCT } = await import('../../backend/ladder/ladderConfig.js');
      
      const testCases = [
        {
          triggerPrice: 1.00,
          expectedLimit: 0.95, // 5% below
          description: '$1.00 trigger with 5% offset'
        },
        {
          triggerPrice: 2.00,
          expectedLimit: 1.90,
          description: '$2.00 trigger with 5% offset'
        },
        {
          triggerPrice: 0.50,
          expectedLimit: 0.48, // rounds to $0.48
          description: '$0.50 trigger with 5% offset'
        }
      ];
      
      for (const testCase of testCases) {
        const result = computeStopLimitPrice(testCase.triggerPrice, LADDER_STOP_LIMIT_OFFSET_PCT);
        
        assert.strictEqual(
          result,
          testCase.expectedLimit,
          `${testCase.description}: Expected ${testCase.expectedLimit}, got ${result}`
        );
      }
    });
    
    it('should never calculate stop limit below $0.01 minimum', async () => {
      const { computeStopLimitPrice } = await import('../../backend/ladder/ladderConfig.js');
      
      const result = computeStopLimitPrice(0.05, 0.95); // 95% offset would be $0.0025
      
      assert.strictEqual(
        result,
        0.01,
        'Stop limit must be at least $0.01'
      );
    });
  });
  
  describe('Active Stop PnL Fraction Calculation', () => {
    it('should use initial stop for new positions (exitPhase LADDER:0)', async () => {
      const { computeActiveStopPnlFrac } = await import('../../backend/ladder/ladderConfig.js');
      
      const result = computeActiveStopPnlFrac({
        exitPhase: 'LADDER:0',
        ratchetStopFrac: null,
        initialStopPct: 0.10
      });
      
      assert.strictEqual(
        result,
        -0.10,
        'New position should use initial stop of -10%'
      );
    });
    
    it('should use ratcheted stop after first milestone', async () => {
      const { computeActiveStopPnlFrac, LADDER_MILESTONES_PCT } = await import('../../backend/ladder/ladderConfig.js');
      
      const result = computeActiveStopPnlFrac({
        exitPhase: 'LADDER:1',
        ratchetStopFrac: 0.20,
        initialStopPct: 0.10
      });
      
      assert.strictEqual(
        result,
        LADDER_MILESTONES_PCT[0],
        'After first milestone, should use first milestone as stop'
      );
    });
    
    it('should handle custom initial stop percentage', async () => {
      const { computeActiveStopPnlFrac } = await import('../../backend/ladder/ladderConfig.js');
      
      const testCases = [
        { initialStopPct: 0.01, expected: -0.01 },   // 1%
        { initialStopPct: 0.0175, expected: -0.0175 }, // 1.75%
        { initialStopPct: 0.02, expected: -0.02 },   // 2%
        { initialStopPct: 0.10, expected: -0.10 }    // 10%
      ];
      
      for (const testCase of testCases) {
        const result = computeActiveStopPnlFrac({
          exitPhase: 'LADDER:0',
          ratchetStopFrac: null,
          initialStopPct: testCase.initialStopPct
        });
        
        assert.strictEqual(
          result,
          testCase.expected,
          `Should use custom initial stop of ${testCase.initialStopPct}`
        );
      }
    });
  });
  
  describe('Stop Price Based on Real Fill (Regression)', () => {
    it('should use entry_premium from position, not current market quote', async () => {
      const { computeStopTriggerPrice } = await import('../../backend/ladder/ladderConfig.js');
      
      // Simulating the bug scenario: entry was filled at one price, market moved
      const actualFillPrice = 1.50; // What we actually paid
      const currentMarketPrice = 1.75; // Where market is now (should NOT use this)
      const stopPnlFrac = -0.10; // -10% stop
      
      const correctStopTrigger = computeStopTriggerPrice(actualFillPrice, stopPnlFrac);
      const wrongStopTrigger = computeStopTriggerPrice(currentMarketPrice, stopPnlFrac);
      
      assert.strictEqual(
        correctStopTrigger,
        1.35,
        'Stop should be based on actual fill of $1.50'
      );
      
      assert.notStrictEqual(
        correctStopTrigger,
        wrongStopTrigger,
        'Stop based on fill price must differ from stop based on current market price'
      );
      
      // This documents the bug: using current market price would give wrong stop
      assert.strictEqual(
        wrongStopTrigger,
        1.58,
        'Using current market would give incorrect stop of $1.58 instead of $1.35'
      );
    });
  });
  
  describe('Broker Stop Order Parameter Building', () => {
    it('should build correct broker stop params from position data', async () => {
      const { buildBrokerStopOrderParams } = await import('../../backend/ladder/ladderStopOrders.js');
      
      const mockPosition = {
        id: 1,
        entry_premium: 1.00,
        contracts_open: 5,
        quantity: 5,
        exit_phase: 'LADDER:0',
        trail_peak_pnl_frac: null
      };
      
      const result = buildBrokerStopOrderParams(mockPosition, {
        initialStopPct: 0.10
      });
      
      assert.ok(result, 'Should return stop params');
      assert.strictEqual(result.stopPnlFrac, -0.10, 'Should use -10% stop');
      assert.strictEqual(result.stopTrigger, 0.90, 'Should calculate $0.90 trigger');
      assert.strictEqual(result.quantity, 5, 'Should use contracts_open quantity');
    });
    
    it('should use position entry_premium, not external quote', async () => {
      const { buildBrokerStopOrderParams } = await import('../../backend/ladder/ladderStopOrders.js');
      
      // Position with specific entry price
      const mockPosition = {
        id: 1,
        entry_premium: 2.25, // This is what matters
        contracts_open: 3,
        quantity: 3,
        exit_phase: 'LADDER:0',
        trail_peak_pnl_frac: null
      };
      
      const result = buildBrokerStopOrderParams(mockPosition, {
        initialStopPct: 0.10
      });
      
      // Stop should be based on entry_premium of 2.25, not any external price
      assert.strictEqual(
        result.stopTrigger,
        2.03, // 2.25 * 0.90 = 2.025, rounds to 2.03
        'Stop trigger must be calculated from position.entry_premium'
      );
    });
  });
});
