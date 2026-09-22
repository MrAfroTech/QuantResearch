import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLASH_STOP_MAX_HOLD_MS,
  applyCloseOutcomesToSuppression,
  applyRetestClearance,
  barClosedAtMs,
  closeOutcomeId,
  holdMsFromTimestamps,
  isBreakoutLevelSpent,
  isFlashStopHold,
  isRepeatBlocked,
  isRetestClearanceBar,
  listAppliedCloseIds,
  listRepeatBlocks,
  listSpentLevels,
  shouldSuppressBreakout,
  spentLevelKey,
  withRepeatBlock,
  withSpentBreakoutLevel,
} from './spentBreakoutLevel.js';

describe('spentBreakoutLevel', () => {
  it('keys direction and numeric level the way ORB/Premarket persist them', () => {
    assert.equal(spentLevelKey('PUT', 292.84), 'PUT:292.84');
    assert.equal(spentLevelKey('PUT', '292.62'), 'PUT:292.62');
  });

  it('marks a hard-spent level and then rejects a re-claim', () => {
    const spent = withSpentBreakoutLevel([], 'PUT', 292.84);
    assert.deepEqual(spent, ['PUT:292.84']);
    assert.equal(isBreakoutLevelSpent({ spent_levels: spent }, 'PUT', 292.84), true);
    assert.equal(isBreakoutLevelSpent({ spent_levels: spent }, 'CALL', 294.155), false);
    assert.deepEqual(withSpentBreakoutLevel(spent, 'PUT', 292.84), ['PUT:292.84']);
    assert.deepEqual(listSpentLevels({}), []);
  });

  it('repeat-blocks a level without hard-spending it', () => {
    const repeat = withRepeatBlock([], 'CALL', 758.74);
    const fsm = { spent_levels: [], repeat_blocks: repeat };
    assert.equal(isRepeatBlocked(fsm, 'CALL', 758.74), true);
    assert.equal(isBreakoutLevelSpent(fsm, 'CALL', 758.74), false);
    assert.equal(shouldSuppressBreakout(fsm, 'CALL', 758.74), true);
    assert.equal(shouldSuppressBreakout(fsm, 'PUT', 757.55), false);
    assert.deepEqual(listRepeatBlocks({}), []);
  });

  it('treats a close back through the level as a retest clearance', () => {
    assert.equal(isRetestClearanceBar('CALL', 758.74, { close: 758.71 }), true);
    assert.equal(isRetestClearanceBar('CALL', 758.74, { close: 758.89 }), false);
    assert.equal(isRetestClearanceBar('PUT', 287.67, { close: 287.8 }), true);
    assert.equal(isRetestClearanceBar('PUT', 287.67, { close: 287.5 }), false);

    const blocked = {
      spent_levels: ['CALL:758.74', 'PUT:757.55'],
      repeat_blocks: ['CALL:758.74'],
    };
    const inside = applyRetestClearance(blocked, 758.74, 757.55, { close: 758.71 });
    assert.deepEqual(inside.spent_levels, []);
    assert.deepEqual(inside.repeat_blocks, []);

    const stillBelowPut = applyRetestClearance(
      { spent_levels: ['PUT:757.55'], repeat_blocks: [] },
      758.74,
      757.55,
      { close: 757.4 }
    );
    assert.deepEqual(stillBelowPut.spent_levels, ['PUT:757.55']);
  });

  it('pardons a flash stop-out and hard-spends only a meaningful-duration loss', () => {
    const seeded = {
      spent_levels: ['CALL:758.74'],
      repeat_blocks: ['CALL:758.74'],
    };

    const flash = applyCloseOutcomesToSuppression(seeded, [
      {
        direction: 'CALL',
        level: 758.74,
        holdMs: 1002,
        realizedPnl: -3,
        closedAt: '2026-09-10T14:25:22.753Z',
      },
    ]);
    assert.deepEqual(flash.spent_levels, []);
    assert.deepEqual(flash.repeat_blocks, []);
    assert.equal(shouldSuppressBreakout(flash, 'CALL', 758.74), false);

    const loss = applyCloseOutcomesToSuppression({ spent_levels: [], repeat_blocks: ['CALL:758.74'] }, [
      {
        direction: 'CALL',
        level: 758.74,
        holdMs: 90_000,
        realizedPnl: -12,
        closedAt: '2026-09-10T14:27:00Z',
      },
    ]);
    assert.equal(isBreakoutLevelSpent(loss, 'CALL', 758.74), true);
    assert.equal(isRepeatBlocked(loss, 'CALL', 758.74), false);

    const win = applyCloseOutcomesToSuppression({ spent_levels: ['PUT:757.55'] }, [
      {
        direction: 'PUT',
        level: 757.55,
        holdMs: 97_825,
        realizedPnl: 8,
        closedAt: '2026-09-10T13:57:02Z',
      },
    ]);
    assert.equal(isBreakoutLevelSpent(win, 'PUT', 757.55), false);
    assert.equal(isRepeatBlocked(win, 'PUT', 757.55), true);
  });

  it('uses a 60s flash threshold', () => {
    assert.equal(FLASH_STOP_MAX_HOLD_MS, 60_000);
    assert.equal(isFlashStopHold(59_999), true);
    assert.equal(isFlashStopHold(60_000), false);
    const spyHold = holdMsFromTimestamps(
      '2026-09-10 14:25:21.750761+00',
      '2026-09-10 14:25:22.753583+00'
    );
    assert.ok(spyHold > 0 && spyHold < 60_000);
  });

  it('applies a given close outcome only once across polls', () => {
    const flash = {
      direction: 'PUT',
      breakout_level: 707.56,
      opened_at: '2026-09-15 14:15:20.447122+00',
      closed_at: '2026-09-15 14:16:01.777805+00',
      realized_pnl: -4,
    };
    const id = closeOutcomeId({
      direction: 'PUT',
      level: 707.56,
      opened_at: flash.opened_at,
      closed_at: flash.closed_at,
    });
    assert.ok(id);

    const blocked = {
      spent_levels: [],
      repeat_blocks: ['PUT:707.56'],
    };
    const first = applyCloseOutcomesToSuppression(blocked, [flash]);
    assert.deepEqual(first.repeat_blocks, []);
    assert.deepEqual(first.spent_levels, []);
    assert.deepEqual(listAppliedCloseIds(first), [id]);
    assert.equal(shouldSuppressBreakout(first, 'PUT', 707.56), false);

    const reblocked = {
      ...first,
      repeat_blocks: ['PUT:707.56'],
    };
    const second = applyCloseOutcomesToSuppression(reblocked, [flash]);
    assert.deepEqual(second.repeat_blocks, ['PUT:707.56']);
    assert.deepEqual(listAppliedCloseIds(second), [id]);
    assert.equal(shouldSuppressBreakout(second, 'PUT', 707.56), true);
  });

  it('computes ET bar close time from a wall-clock stamp', () => {
    const closeMs = barClosedAtMs({ time: '2026-09-10T10:20:00' }, 5);
    assert.equal(new Date(closeMs).toISOString(), '2026-09-10T14:25:00.000Z');
  });
});
