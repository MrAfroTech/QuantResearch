import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCHEDULED_TRADING_HALT_REASON,
  parseHaltUntil,
  isScheduledTradingHaltActive,
  formatHaltUntilEt,
} from './tradingHalt.js';

const here = dirname(fileURLToPath(import.meta.url));
const haltSrc = readFileSync(join(here, 'tradingHalt.js'), 'utf8');
const gateSrc = readFileSync(join(here, 'liveEntryGate.js'), 'utf8');
const schedulerSrc = readFileSync(join(here, '../scheduler.js'), 'utf8');
const handlerSrc = readFileSync(join(here, '../handlers.js'), 'utf8');
const telegramSrc = readFileSync(join(here, '../telegramHandler.js'), 'utf8');
const dbSrc = readFileSync(join(here, '../db.js'), 'utf8');

const MONDAY_0930_ET = Date.parse('2026-09-21T13:30:00.000Z');

describe('scheduled trading halt until Monday 9:30 ET', () => {
  it('parses timestamptz Date and ISO strings', () => {
    assert.equal(parseHaltUntil(null), null);
    assert.equal(parseHaltUntil(''), null);
    assert.equal(parseHaltUntil(new Date(MONDAY_0930_ET)), MONDAY_0930_ET);
    assert.equal(parseHaltUntil('2026-09-21T13:30:00.000Z'), MONDAY_0930_ET);
    assert.equal(parseHaltUntil('2026-09-21 13:30:00+00'), MONDAY_0930_ET);
  });

  it('blocks new entries before 9:30 ET Monday and resumes at that instant', () => {
    assert.equal(isScheduledTradingHaltActive(new Date('2026-09-18T14:30:00.000Z'), MONDAY_0930_ET), true);
    assert.equal(isScheduledTradingHaltActive(MONDAY_0930_ET - 1, MONDAY_0930_ET), true);
    assert.equal(isScheduledTradingHaltActive(MONDAY_0930_ET, MONDAY_0930_ET), false);
    assert.equal(isScheduledTradingHaltActive(MONDAY_0930_ET + 1, MONDAY_0930_ET), false);
    assert.equal(isScheduledTradingHaltActive(new Date(), null), false);
  });

  it('formats the resume time in America/New_York', () => {
    const label = formatHaltUntilEt(MONDAY_0930_ET);
    assert.match(label, /Sep/);
    assert.match(label, /21/);
    assert.match(label, /2026/);
    assert.match(label, /9:30/);
    assert.match(label, /AM/i);
  });

  it('live entry gate blocks on scheduled halt after the live-env check', () => {
    assert.equal(SCHEDULED_TRADING_HALT_REASON, 'scheduled_trading_halt');
    assert.match(gateSrc, /getScheduledTradingHalt/);
    assert.match(gateSrc, /SCHEDULED_TRADING_HALT_REASON/);
    const gateFn = gateSrc.slice(gateSrc.indexOf('export async function checkLiveEntryGate'));
    const liveCheck = gateFn.indexOf("environment !== 'live'");
    const haltCheck = gateFn.indexOf('getScheduledTradingHalt');
    assert.ok(liveCheck >= 0 && haltCheck > liveCheck, 'halt must run only for live strategies');
  });

  it('scheduler resumes the halt and skips 0DTE scans while it is active, without stopping monitors', () => {
    assert.match(schedulerSrc, /maybeResumeScheduledHalt/);
    assert.match(schedulerSrc, /getScheduledTradingHalt/);
    assert.match(schedulerSrc, /entriesHalted|halt.active/);
    assert.match(schedulerSrc, /runOrbScanAndExecute/);
    assert.match(schedulerSrc, /monitorOrbPositions/);
    const monitorBody = schedulerSrc.slice(
      schedulerSrc.indexOf('async function runZeroDtePositionMonitorCycleBody'),
      schedulerSrc.indexOf('export async function runPollCycle')
    );
    const resumeAt = monitorBody.indexOf('maybeResumeScheduledHalt');
    const orbScanAt = monitorBody.indexOf('runOrbScanAndExecute');
    const monitorAt = monitorBody.indexOf('monitorOrbPositions');
    assert.ok(resumeAt >= 0, '0DTE monitor must try to resume the halt');
    assert.ok(monitorAt > resumeAt, 'position monitors must still run after the resume check');
    assert.equal(orbScanAt, -1, '0DTE monitor must not place new entries');
  });

  it('dashboard AUTO and Telegram GO cannot lift a still-active halt', () => {
    assert.match(handlerSrc, /getScheduledTradingHalt/);
    const switchFn = handlerSrc.slice(handlerSrc.indexOf('export async function switchExecutionMode'));
    assert.match(switchFn, /halt\.active/);
    assert.match(switchFn, /AUTO is blocked/);
    assert.match(telegramSrc, /halt_blocks_go/);
    assert.match(telegramSrc, /getScheduledTradingHalt/);
  });

  it('schema ensures entries_halted_until exists and resume clears it with a compare-and-swap', () => {
    assert.match(dbSrc, /entries_halted_until TIMESTAMPTZ/);
    assert.match(haltSrc, /entries_halted_until = NULL/);
    assert.match(haltSrc, /entries_halted_until <= \$\{now\}/);
    assert.match(haltSrc, /setEmaVwapMode\('AUTO'\)/);
  });
});
