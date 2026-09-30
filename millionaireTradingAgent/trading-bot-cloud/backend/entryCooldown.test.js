import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STOP_LOSS_REENTRY_COOLDOWN_MS,
  evaluateStopLossCooldown,
  formatCooldownRemaining,
} from './entryCooldown.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('ORB 20-minute stop-loss cooldown', () => {
  it('is a 20-minute countdown', () => {
    assert.equal(STOP_LOSS_REENTRY_COOLDOWN_MS, 20 * 60 * 1000);
    assert.equal(formatCooldownRemaining(125000), '2m 5s');
    assert.equal(formatCooldownRemaining(5000), '5s');
  });

  it('blocks until 20 minutes after the stop and then allows', () => {
    const closedAt = '2026-09-30T14:00:00.000Z';
    const closedMs = Date.parse(closedAt);
    const inside = evaluateStopLossCooldown(closedAt, closedMs + 19 * 60 * 1000);
    assert.equal(inside.blocked, true);
    assert.equal(inside.remainingMs, 60 * 1000);

    const elapsed = evaluateStopLossCooldown(closedAt, closedMs + STOP_LOSS_REENTRY_COOLDOWN_MS);
    assert.equal(elapsed.blocked, false);
    assert.equal(elapsed.remainingMs, 0);
  });

  it('does not block when there is no stop-loss close', () => {
    assert.deepEqual(evaluateStopLossCooldown(null), {
      blocked: false,
      remainingMs: 0,
      closedAt: null,
    });
  });

  it('is wired into ORB only, and ORB stop_loss is not an all-day ban', () => {
    const orb = readFileSync(join(here, 'orb/orbExecutor.js'), 'utf8');
    const premarket = readFileSync(join(here, 'premarketBreakout/premarketExecutor.js'), 'utf8');
    const ema = readFileSync(join(here, 'emaVwapCross/emaVwapExecutor.js'), 'utf8');
    assert.match(orb, /getStopLossReentryCooldown\(\{/);
    assert.match(orb, /reason: 'stop_loss_cooldown'/);
    assert.match(orb, /reentry\.lastCloseReason !== 'stop_loss'/);
    assert.equal(premarket.includes('getStopLossReentryCooldown'), false);
    assert.equal(ema.includes('getStopLossReentryCooldown'), false);
  });
});
