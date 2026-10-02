import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORB_LEVEL_SPENT_AFTER_LOSS_REASON,
  evaluateOrbLevelSpentAfterLoss,
} from './orbLevelSpentAfterLoss.js';

const LEVEL = 763.21;

function row(extra) {
  return {
    direction: 'PUT',
    breakout_level: LEVEL,
    realized_pnl: 13,
    close_reason: 'partial_lock_trail',
    closed_at: '2026-10-01 14:23:41+00',
    ...extra,
  };
}

describe('ORB level spent only after a losing close', () => {
  it('allows the first attempt when nothing has closed', () => {
    const gate = evaluateOrbLevelSpentAfterLoss([], { direction: 'PUT', breakoutLevel: LEVEL });
    assert.equal(gate.blocked, false);
  });

  it('allows another attempt after a win or a scratch', () => {
    const win = evaluateOrbLevelSpentAfterLoss(
      [row({ realized_pnl: 13 })],
      { direction: 'PUT', breakoutLevel: LEVEL }
    );
    const scratch = evaluateOrbLevelSpentAfterLoss(
      [row({ realized_pnl: 0, close_reason: 'trailing_stop' })],
      { direction: 'PUT', breakoutLevel: LEVEL }
    );
    assert.equal(win.blocked, false);
    assert.equal(scratch.blocked, false);
  });

  it('spends the level after a losing close, including a flash loss', () => {
    const gate = evaluateOrbLevelSpentAfterLoss(
      [row({ realized_pnl: -14, close_reason: 'stop_loss', closed_at: '2026-10-01 14:25:42+00' })],
      { direction: 'PUT', breakoutLevel: LEVEL }
    );
    assert.equal(gate.blocked, true);
    assert.equal(gate.reason, ORB_LEVEL_SPENT_AFTER_LOSS_REASON);
    assert.equal(gate.realizedPnl, -14);
  });

  it('keeps the level spent after a later win on the same key', () => {
    const gate = evaluateOrbLevelSpentAfterLoss(
      [
        row({ realized_pnl: -14, close_reason: 'stop_loss' }),
        row({ realized_pnl: 14, close_reason: 'partial_lock_trail' }),
      ],
      { direction: 'PUT', breakoutLevel: LEVEL }
    );
    assert.equal(gate.blocked, true);
  });

  it('treats the opposite direction and a different level as separate', () => {
    const loss = row({ realized_pnl: -14, close_reason: 'stop_loss' });
    const call = evaluateOrbLevelSpentAfterLoss([loss], { direction: 'CALL', breakoutLevel: LEVEL });
    const otherLevel = evaluateOrbLevelSpentAfterLoss([loss], { direction: 'PUT', breakoutLevel: 765.34 });
    assert.equal(call.blocked, false);
    assert.equal(otherLevel.blocked, false);
  });

  it('ignores a never-opened close', () => {
    const gate = evaluateOrbLevelSpentAfterLoss(
      [row({ realized_pnl: -14, close_reason: 'entry_never_filled' })],
      { direction: 'PUT', breakoutLevel: LEVEL }
    );
    assert.equal(gate.blocked, false);
  });
});
