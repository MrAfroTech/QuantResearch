import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STOP_LOSS_PCT, SWING_HARD_STOP_PCT } from './positionManager.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('Swing stop percentages', () => {
  it('uses 1.75% soft / 2% hard, not the old 6.5%/10% defaults', () => {
    assert.equal(STOP_LOSS_PCT, 0.0175);
    assert.equal(SWING_HARD_STOP_PCT, 0.02);
  });

  it('monitor passes the Swing-only hard stop, not shared LADDER_HARD_STOP_PCT', () => {
    const src = readFileSync(join(here, 'positionManager.js'), 'utf8');
    assert.match(src, /hardStopPct:\s*SWING_HARD_STOP_PCT/);
    assert.match(src, /initialStopPct:\s*STOP_LOSS_PCT/);
  });
});
