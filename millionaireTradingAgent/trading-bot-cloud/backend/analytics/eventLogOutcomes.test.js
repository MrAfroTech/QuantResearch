import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEventOutcomes,
  sessionHasEnded,
  SESSION_FREEZE_ET_MINUTES,
} from './eventLogOutcomes.js';

const QQQ_CHAIN = [
  {
    id: 1130,
    strategy: 'orb',
    ticker: 'QQQ',
    trade_date: '2026-08-21',
    event_type: 'confirmation_too_explosive',
    direction: 'PUT',
    created_at: '2026-08-21 13:57:11.186117+00',
  },
  {
    id: 1131,
    strategy: 'orb',
    ticker: 'QQQ',
    trade_date: '2026-08-21',
    event_type: 'confirmation_too_explosive',
    direction: 'PUT',
    created_at: '2026-08-21 14:01:21.353724+00',
  },
  {
    id: 1132,
    strategy: 'orb',
    ticker: 'QQQ',
    trade_date: '2026-08-21',
    event_type: 'confirmation_too_explosive',
    direction: 'PUT',
    created_at: '2026-08-21 14:07:56.264504+00',
  },
  {
    id: 1133,
    strategy: 'orb',
    ticker: 'QQQ',
    trade_date: '2026-08-21',
    event_type: 'breakout_invalidated',
    direction: 'PUT',
    created_at: '2026-08-21 14:10:17.785862+00',
  },
];

const SPY_INV = {
  id: 1129,
  strategy: 'orb',
  ticker: 'SPY',
  trade_date: '2026-08-21',
  event_type: 'breakout_invalidated',
  direction: 'PUT',
  created_at: '2026-08-21 13:57:10.93785+00',
};

describe('sessionHasEnded', () => {
  it('uses 15:05 ET freeze', () => {
    assert.equal(SESSION_FREEZE_ET_MINUTES, 15 * 60 + 5);
    const before = new Date('2026-08-21T18:00:00Z'); // 14:00 ET
    const after = new Date('2026-08-21T19:10:00Z'); // 15:10 ET
    assert.equal(sessionHasEnded('2026-08-21', before), false);
    assert.equal(sessionHasEnded('2026-08-21', after), true);
    assert.equal(sessionHasEnded('2026-08-20', before), true);
  });
});

describe('resolveEventOutcomes', () => {
  it('maps today QQQ explosive chain to the later invalidation', () => {
    const now = new Date('2026-08-21T14:20:00Z');
    const rows = resolveEventOutcomes({
      events: [...QQQ_CHAIN, SPY_INV],
      trades: [],
      now,
    });
    const qqq = rows.filter((r) => r.ticker === 'QQQ').sort((a, b) => a.id - b.id);
    assert.equal(qqq.length, 4);
    for (const row of qqq) {
      assert.equal(row.outcome, 'invalidated');
      assert.equal(row.outcome_label, 'Invalidated — no trade');
    }
    const spy = rows.find((r) => r.ticker === 'SPY');
    assert.equal(spy.outcome, 'invalidated');
  });

  it('points earlier explosive rejects at a later same-day fill', () => {
    const events = [
      {
        id: 1,
        strategy: 'orb',
        ticker: 'SPY',
        trade_date: '2026-08-19',
        event_type: 'confirmation_too_explosive',
        direction: 'CALL',
        created_at: '2026-08-19T14:40:00Z',
      },
      {
        id: 2,
        strategy: 'orb',
        ticker: 'SPY',
        trade_date: '2026-08-19',
        event_type: 'confirmation_too_explosive',
        direction: 'CALL',
        created_at: '2026-08-19T14:45:00Z',
      },
    ];
    const trades = [
      {
        id: 72,
        strategy: 'orb',
        ticker: 'SPY',
        direction: 'CALL',
        opened_at: '2026-08-19T14:50:00Z',
        close_reason: 'profit_target',
        realized_pnl: 31.7,
      },
    ];
    const rows = resolveEventOutcomes({
      events,
      trades,
      now: new Date('2026-08-19T20:00:00Z'),
    });
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.outcome, 'filled');
      assert.equal(row.trade_id, 72);
      assert.match(row.outcome_label, /profit_target/);
      assert.match(row.outcome_label, /\+\$31\.70/);
    }
  });

  it('does not attach a later attempt fill to a prior invalidation', () => {
    const events = [
      {
        id: 1,
        strategy: 'orb',
        ticker: 'IWM',
        trade_date: '2026-08-21',
        event_type: 'confirmation_too_explosive',
        direction: 'PUT',
        created_at: '2026-08-21T14:00:00Z',
      },
      {
        id: 2,
        strategy: 'orb',
        ticker: 'IWM',
        trade_date: '2026-08-21',
        event_type: 'breakout_invalidated',
        direction: 'PUT',
        created_at: '2026-08-21T14:10:00Z',
      },
      {
        id: 3,
        strategy: 'orb',
        ticker: 'IWM',
        trade_date: '2026-08-21',
        event_type: 'confirmation_too_explosive',
        direction: 'PUT',
        created_at: '2026-08-21T14:20:00Z',
      },
    ];
    const trades = [
      {
        id: 99,
        strategy: 'orb',
        ticker: 'IWM',
        direction: 'PUT',
        opened_at: '2026-08-21T14:25:00Z',
        close_reason: 'stop_loss',
        realized_pnl: -3,
      },
    ];
    const rows = resolveEventOutcomes({
      events,
      trades,
      now: new Date('2026-08-21T14:30:00Z'),
    }).sort((a, b) => a.id - b.id);
    assert.equal(rows[0].outcome, 'invalidated');
    assert.equal(rows[1].outcome, 'invalidated');
    assert.equal(rows[2].outcome, 'filled');
    assert.equal(rows[2].trade_id, 99);
  });

  it('marks leftover explosive rejects abandoned after 15:05 ET', () => {
    const events = [
      {
        id: 10,
        strategy: 'orb',
        ticker: 'QQQ',
        trade_date: '2026-08-14',
        event_type: 'confirmation_too_explosive',
        direction: 'PUT',
        created_at: '2026-08-14T15:05:00Z',
      },
    ];
    const rows = resolveEventOutcomes({
      events,
      trades: [],
      now: new Date('2026-08-14T19:10:00Z'),
    });
    assert.equal(rows[0].outcome, 'abandoned');
    assert.equal(rows[0].outcome_label, 'No fill — session ended');
  });

  it('keeps unresolved same-day rejects pending before session freeze', () => {
    const events = [
      {
        id: 11,
        strategy: 'premarket',
        ticker: 'SPY',
        trade_date: '2026-08-21',
        event_type: 'confirmation_too_explosive',
        direction: 'CALL',
        created_at: '2026-08-21T14:00:00Z',
      },
    ];
    const rows = resolveEventOutcomes({
      events,
      trades: [],
      now: new Date('2026-08-21T14:30:00Z'),
    });
    assert.equal(rows[0].outcome, 'pending');
    assert.equal(rows[0].outcome_label, 'Awaiting confirmation');
  });
});
