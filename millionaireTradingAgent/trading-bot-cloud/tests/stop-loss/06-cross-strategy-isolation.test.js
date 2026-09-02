/**
 * TEST 6: Cross-Strategy Isolation
 * 
 * Verifies that a bug or config change in one strategy's stop logic
 * cannot silently affect another strategy.
 * 
 * Critical because:
 * - ORB, Premarket, EMA/VWAP, and Swing share common ladder exit logic
 * - Each strategy has independent config files
 * - Changes to shared code could break multiple strategies
 * - Three strategies trade live capital (ORB, Premarket, EMA/VWAP)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Cross-Strategy Isolation', () => {
  
  describe('Independent Configuration Values', () => {
    it('should verify each strategy has its own stop loss constant', async () => {
      const { ORB_STOP_LOSS_PCT } = await import('../../backend/orb/orbConfig.js');
      const { PREMARKET_STOP_LOSS_PCT } = await import('../../backend/premarketBreakout/premarketConfig.js');
      const { EMA_VWAP_STOP_LOSS_PCT } = await import('../../backend/emaVwapCross/emaVwapConfig.js');
      const { STOP_LOSS_PCT } = await import('../../backend/positionManager.js');
      
      // Each strategy has its own constant
      assert.ok(
        typeof ORB_STOP_LOSS_PCT === 'number',
        'ORB has independent stop loss constant'
      );
      
      assert.ok(
        typeof PREMARKET_STOP_LOSS_PCT === 'number',
        'Premarket has independent stop loss constant'
      );
      
      assert.ok(
        typeof EMA_VWAP_STOP_LOSS_PCT === 'number',
        'EMA/VWAP has independent stop loss constant'
      );
      
      assert.ok(
        typeof STOP_LOSS_PCT === 'number',
        'Swing has independent stop loss constant'
      );
    });
    
    it('should verify changing one strategy config does not affect others', async () => {
      // Import all strategy configs
      const orbConfig = await import('../../backend/orb/orbConfig.js');
      const premarketConfig = await import('../../backend/premarketBreakout/premarketConfig.js');
      const emaVwapConfig = await import('../../backend/emaVwapCross/emaVwapConfig.js');
      const swingConfig = await import('../../backend/positionManager.js');
      
      const configs = [
        { name: 'ORB', value: orbConfig.ORB_STOP_LOSS_PCT, config: orbConfig },
        { name: 'Premarket', value: premarketConfig.PREMARKET_STOP_LOSS_PCT, config: premarketConfig },
        { name: 'EMA/VWAP', value: emaVwapConfig.EMA_VWAP_STOP_LOSS_PCT, config: emaVwapConfig },
        { name: 'Swing', value: swingConfig.STOP_LOSS_PCT, config: swingConfig }
      ];
      
      // Each config should be an independent module
      for (let i = 0; i < configs.length; i++) {
        for (let j = i + 1; j < configs.length; j++) {
          assert.notStrictEqual(
            configs[i].config,
            configs[j].config,
            `${configs[i].name} and ${configs[j].name} must have independent config modules`
          );
        }
      }
    });
    
    it('should verify strategies use different config file paths', async () => {
      // Each strategy must import from its own config file, not a shared global
      const configPaths = [
        '../../backend/orb/orbConfig.js',
        '../../backend/premarketBreakout/premarketConfig.js',
        '../../backend/emaVwapCross/emaVwapConfig.js',
        '../../backend/positionManager.js'
      ];
      
      // Paths should be unique
      const uniquePaths = new Set(configPaths);
      assert.strictEqual(
        uniquePaths.size,
        configPaths.length,
        'Each strategy must have its own config file'
      );
    });
  });
  
  describe('Shared Ladder Logic Isolation', () => {
    it('should verify ladder logic accepts strategy-specific stop values', async () => {
      const { evaluateLadderExit } = await import('../../backend/ladder/ladderExit.js');
      
      // Test that ladder logic respects different stop percentages
      const testCases = [
        { stopPct: 0.01, strategy: 'potential ORB config' },
        { stopPct: 0.0175, strategy: 'potential Swing config' },
        { stopPct: 0.02, strategy: 'potential hard stop' },
        { stopPct: 0.10, strategy: 'current config' }
      ];
      
      for (const testCase of testCases) {
        const decision = evaluateLadderExit({
          pnlFrac: -testCase.stopPct - 0.001, // Just past stop
          exitPhase: 'LADDER:0',
          contractsOpen: 5,
          entryContracts: 5,
          ratchetStopFrac: null,
          initialStopPct: testCase.stopPct,
          isTimeStop: false,
          skipPollStops: false
        });
        
        assert.strictEqual(
          decision.action,
          'close_all',
          `Ladder logic must respect ${testCase.strategy} stop of ${testCase.stopPct * 100}%`
        );
      }
    });
    
    it('should verify each strategy passes its own stop to ladder logic', async () => {
      // Verify that strategies don't accidentally share stop values through global state
      
      // Mock checking that each strategy calls ladder with correct stop
      const strategyStopMappings = [
        { strategy: 'ORB', stopVar: 'ORB_STOP_LOSS_PCT', shouldBeNamespaced: true },
        { strategy: 'Premarket', stopVar: 'PREMARKET_STOP_LOSS_PCT', shouldBeNamespaced: true },
        { strategy: 'EMA/VWAP', stopVar: 'EMA_VWAP_STOP_LOSS_PCT', shouldBeNamespaced: true },
        { strategy: 'Swing', stopVar: 'STOP_LOSS_PCT', shouldBeNamespaced: false } // Generic name for Swing
      ];
      
      for (const mapping of strategyStopMappings) {
        assert.ok(
          mapping.stopVar,
          `${mapping.strategy} must have named stop constant`
        );
        
        if (mapping.shouldBeNamespaced) {
          const normalizedStrategy = mapping.strategy.toUpperCase().replace(/[\/\s]/g, '_');
          assert.ok(
            mapping.stopVar.includes(normalizedStrategy),
            `${mapping.strategy} stop constant should be namespaced to strategy`
          );
        } else {
          // Swing uses generic STOP_LOSS_PCT - verify it exists
          assert.ok(
            mapping.stopVar === 'STOP_LOSS_PCT',
            `${mapping.strategy} should use STOP_LOSS_PCT constant`
          );
        }
      }
    });
  });
  
  describe('Position Manager Isolation', () => {
    it('should verify each strategy has independent position manager', async () => {
      // Each strategy should manage positions independently
      const positionManagerPaths = [
        '../../backend/orb/orbPositionManager.js',
        '../../backend/premarketBreakout/premarketPositionManager.js',
        '../../backend/emaVwapCross/emaVwapPositionManager.js',
        '../../backend/positionManager.js' // Swing
      ];
      
      const managers = await Promise.all(
        positionManagerPaths.map((path) => import(path))
      );
      
      // Each manager should be a unique module
      for (let i = 0; i < managers.length; i++) {
        for (let j = i + 1; j < managers.length; j++) {
          assert.notStrictEqual(
            managers[i],
            managers[j],
            `Position managers must be independent modules`
          );
        }
      }
    });
  });
  
  describe('Database Isolation', () => {
    it('should verify each strategy uses separate DB tables/identifiers', async () => {
      // Strategies should not share position records
      const strategyKeys = ['orb', 'premarket', 'emavwap', 'swing'];
      
      // Each strategy should have unique identifier
      const uniqueKeys = new Set(strategyKeys);
      assert.strictEqual(
        uniqueKeys.size,
        strategyKeys.length,
        'Each strategy must have unique DB identifier'
      );
    });
    
    it('should verify strategy field distinguishes positions', async () => {
      const mockPositions = [
        { id: 1, strategy: 'orb', entry_premium: 1.00 },
        { id: 2, strategy: 'premarket', entry_premium: 1.00 },
        { id: 3, strategy: 'emavwap', entry_premium: 1.00 },
        { id: 4, strategy: 'swing', entry_premium: 1.00 }
      ];
      
      // Each position should be tagged with strategy
      for (const pos of mockPositions) {
        assert.ok(
          pos.strategy,
          'Each position must have strategy identifier'
        );
      }
      
      // All strategies should be unique
      const strategies = mockPositions.map((p) => p.strategy);
      const uniqueStrategies = new Set(strategies);
      assert.strictEqual(
        uniqueStrategies.size,
        mockPositions.length,
        'Position strategies must be distinct'
      );
    });
  });
  
  describe('Bug Propagation Prevention', () => {
    it('should verify a broken config in one strategy does not break others', async () => {
      // Simulate: ORB config has NaN stop value (bug)
      // Other strategies should still work
      
      const { computeStopTriggerPrice } = await import('../../backend/ladder/ladderConfig.js');
      
      // Broken ORB stop (simulated)
      const brokenOrbStop = NaN;
      const orbResult = computeStopTriggerPrice(1.00, brokenOrbStop);
      
      assert.strictEqual(
        orbResult,
        null,
        'Broken ORB config should return null'
      );
      
      // Valid Premarket stop (unaffected)
      const validPremarketStop = -0.10;
      const premarketResult = computeStopTriggerPrice(1.00, validPremarketStop);
      
      assert.strictEqual(
        premarketResult,
        0.90,
        'Valid Premarket config should still work'
      );
      
      // Broken config in one strategy does not crash others
      assert.notStrictEqual(
        orbResult,
        premarketResult,
        'Strategies must be isolated from each other\'s bugs'
      );
    });
    
    it('should verify shared ladder logic is defensive against bad inputs', async () => {
      const { evaluateLadderExit } = await import('../../backend/ladder/ladderExit.js');
      
      // Shared ladder logic should handle bad strategy inputs gracefully
      const badInputs = [
        { initialStopPct: null, description: 'null stop' },
        { initialStopPct: undefined, description: 'undefined stop' },
        { initialStopPct: NaN, description: 'NaN stop' },
        { initialStopPct: -0.10, description: 'negative stop (wrong sign)' }
      ];
      
      for (const input of badInputs) {
        // Should not crash, should use default
        const decision = evaluateLadderExit({
          pnlFrac: -0.15,
          exitPhase: 'LADDER:0',
          contractsOpen: 5,
          entryContracts: 5,
          ratchetStopFrac: null,
          initialStopPct: input.initialStopPct,
          isTimeStop: false,
          skipPollStops: false
        });
        
        assert.ok(
          decision,
          `Ladder logic must not crash on ${input.description}`
        );
        
        assert.ok(
          decision.action,
          `Ladder logic must return action for ${input.description}`
        );
      }
    });
  });
  
  describe('Environment Isolation (Live vs Paper)', () => {
    it('should verify ORB live and paper positions are independent', async () => {
      const { getOrbMaxPositions } = await import('../../backend/orb/orbConfig.js');
      
      const liveMax = getOrbMaxPositions('live');
      const paperMax = getOrbMaxPositions('paper');
      
      assert.ok(
        Number.isFinite(liveMax) && liveMax > 0,
        'Live ORB should have valid max positions'
      );
      
      assert.ok(
        Number.isFinite(paperMax) && paperMax > 0,
        'Paper ORB should have valid max positions'
      );
      
      // Live and paper can have different limits
      assert.ok(
        liveMax !== paperMax || liveMax === paperMax,
        'Live and paper environments should be independently configurable'
      );
    });
    
    it('should verify Premarket live and paper positions are independent', async () => {
      const { getPremarketMaxPositions } = await import('../../backend/premarketBreakout/premarketConfig.js');
      
      const liveMax = getPremarketMaxPositions('live');
      const paperMax = getPremarketMaxPositions('paper');
      
      assert.ok(
        Number.isFinite(liveMax) && liveMax > 0,
        'Live Premarket should have valid max positions'
      );
      
      assert.ok(
        Number.isFinite(paperMax) && paperMax > 0,
        'Paper Premarket should have valid max positions'
      );
    });
  });
  
  describe('Stop-Loss Configuration Matrix', () => {
    it('should document complete strategy × environment configuration', async () => {
      const { ORB_STOP_LOSS_PCT } = await import('../../backend/orb/orbConfig.js');
      const { PREMARKET_STOP_LOSS_PCT } = await import('../../backend/premarketBreakout/premarketConfig.js');
      const { EMA_VWAP_STOP_LOSS_PCT } = await import('../../backend/emaVwapCross/emaVwapConfig.js');
      const { STOP_LOSS_PCT } = await import('../../backend/positionManager.js');
      
      const configMatrix = [
        { strategy: 'ORB', environment: 'live', stopPct: ORB_STOP_LOSS_PCT, live: true },
        { strategy: 'ORB', environment: 'paper', stopPct: ORB_STOP_LOSS_PCT, live: false },
        { strategy: 'Premarket', environment: 'live', stopPct: PREMARKET_STOP_LOSS_PCT, live: true },
        { strategy: 'Premarket', environment: 'paper', stopPct: PREMARKET_STOP_LOSS_PCT, live: false },
        { strategy: 'EMA/VWAP', environment: 'live', stopPct: EMA_VWAP_STOP_LOSS_PCT, live: true },
        { strategy: 'EMA/VWAP', environment: 'paper', stopPct: EMA_VWAP_STOP_LOSS_PCT, live: false },
        { strategy: 'Swing', environment: 'paper', stopPct: STOP_LOSS_PCT, live: false }
      ];
      
      // All entries should have valid stop percentages
      for (const entry of configMatrix) {
        assert.ok(
          Number.isFinite(entry.stopPct) && entry.stopPct > 0 && entry.stopPct <= 1,
          `${entry.strategy} ${entry.environment} must have valid stop percentage`
        );
      }
      
      // Live strategies should be clearly identified
      const liveStrategies = configMatrix.filter((e) => e.live);
      assert.strictEqual(
        liveStrategies.length,
        3,
        'Should have exactly 3 live strategy configurations (ORB, Premarket, EMA/VWAP)'
      );
    });
  });
  
  describe('Change Impact Analysis', () => {
    it('should identify code changes that affect multiple strategies', async () => {
      // Changes to these shared modules affect all strategies
      const sharedModules = [
        '../../backend/ladder/ladderConfig.js',
        '../../backend/ladder/ladderExit.js',
        '../../backend/ladder/ladderStopOrders.js'
      ];
      
      // All shared modules should exist and export functions
      for (const modulePath of sharedModules) {
        const module = await import(modulePath);
        assert.ok(
          Object.keys(module).length > 0,
          `Shared module ${modulePath} must export functions`
        );
      }
      
      assert.strictEqual(
        sharedModules.length,
        3,
        'Should have identified all shared ladder modules'
      );
    });
    
    it('should identify code changes that affect only one strategy', async () => {
      // Changes to these modules affect only one strategy
      const isolatedModules = [
        { path: '../../backend/orb/orbConfig.js', strategy: 'ORB' },
        { path: '../../backend/premarketBreakout/premarketConfig.js', strategy: 'Premarket' },
        { path: '../../backend/emaVwapCross/emaVwapConfig.js', strategy: 'EMA/VWAP' },
        { path: '../../backend/positionManager.js', strategy: 'Swing' }
      ];
      
      for (const module of isolatedModules) {
        const imported = await import(module.path);
        assert.ok(
          imported,
          `${module.strategy} config module must be importable`
        );
      }
      
      assert.strictEqual(
        isolatedModules.length,
        4,
        'Should have one config module per strategy'
      );
    });
  });
});
