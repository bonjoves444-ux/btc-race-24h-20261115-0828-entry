// Washout catcher for the cbBTC 24-hour race.
//
// The idea, in one paragraph: on a day when bitcoin bleeds lower, the only
// moments that pay are the washouts — a sharp fall that exhausts itself and
// snaps back. Everything in between is noise that costs 26-40 bps a round
// trip to trade. So this bot does almost nothing, on purpose. It watches the
// highest close of the last four hours and waits until the price has fallen
// at least 4% below it and printed one up bar, the first sign the sellers
// are done. Then it goes all in, once, and rides the snap-back to +5% or
// holds up to four hours for the recovery to finish. There is no tight stop:
// a washout buy that is stopped out on the next leg down is exactly the
// trade that would have paid. The only hard exit besides the target is a
// 5% loss on the position itself, a guard against a day that never bounces.
//
// A second, smaller arm covers the quiet day: if nothing has traded by bar
// 1200 and the price dips 1.5% off its one-hour high with two up bars, it
// takes a half-size position for a quick 1% target. That arm never fired on
// the dev window — the washout arm fired first — but it keeps the bot from
// sitting out a whole race window that never washes out.
//
// Two more guards: a 5% peak-to-current equity drawdown stops new entries
// for the rest of the window, and nothing is entered after bar 1380, so a
// late buy cannot be flattened at a loss by the end-of-window sale.
//
// All decisions come from the bars the harness sends. No clock, no network,
// no randomness, no files: the same bars always give the same orders.

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Washout arm: four-hour high, 4% fall, one up bar, +5% target, 4h max hold.
// The target is set at 495 bps, not 500: the harness books the buy's fee
// into the position's cost, so value-over-cost runs about 4 bps behind
// price-over-fill. 495 on value-over-cost is the same +5% on price.
const WASHOUT_BARS = 240;
const WASHOUT_DIP_BPS = 400;
const WASHOUT_TAKE_BPS = 495;
const WASHOUT_HOLD_BARS = 240;

// Quiet-day arm: one-hour high, 1.5% fall, two up bars, half size, +1% target.
const LATE_BAR = 1200;
const LATE_BARS = 60;
const LATE_DIP_BPS = 150;
const LATE_TAKE_BPS = 100;
const LATE_HOLD_BARS = 120;
const LATE_SIZE_BPS = 5000;

// Shared limits.
const HARD_STOP_BPS = 500;
const EQUITY_GUARD_BPS = 500;
const COOLDOWN_BARS = 10;
const LAST_ENTRY_BAR = 1380;
const MAX_SLIPPAGE_BPS = 150;

type Arm = 'washout' | 'late';

const closes: number[] = [];
let prevClose: number | null = null;
let upBars = 0;
let peakEquity = 0n;
let stopped = false;
let everTraded = false;
let lastExitSeq = -1000;
let heldSinceSeq = -1;
let mode: Arm | null = null;
let pendingMode: Arm | null = null;

function rollingHigh(n: number): number | null {
  if (closes.length < n) return null;
  let high = -Infinity;
  for (let i = closes.length - n; i < closes.length; i++) {
    if (closes[i]! > high) high = closes[i]!;
  }
  return high;
}

function dipBps(high: number, close: number): number {
  return Math.round(((high - close) / high) * 10000);
}

await runBars({
  onBatch(state, batch) {
    const orders: (BuyInput | SellInput)[] = [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (!bar) return orders;

    const close = Number(bar.c);
    closes.push(close);
    if (closes.length > WASHOUT_BARS + 5) closes.shift();
    if (prevClose !== null) {
      upBars = close > prevClose ? upBars + 1 : 0;
    }
    prevClose = close;

    if (state.equity > peakEquity) peakEquity = state.equity;
    if (!stopped && peakEquity > 0n && state.equity * 10000n < peakEquity * BigInt(10000 - EQUITY_GUARD_BPS)) {
      stopped = true;
    }

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && heldSinceSeq < 0) heldSinceSeq = state.seq;
    if (held === undefined) {
      heldSinceSeq = -1;
      if (mode !== null && pendingMode === null) mode = null;
    }
    if (held !== undefined && pendingMode !== null) {
      mode = pendingMode;
      pendingMode = null;
    }

    if (held !== undefined) {
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const holdBars = state.seq - heldSinceSeq;
      const takeBps = mode === 'late' ? LATE_TAKE_BPS : WASHOUT_TAKE_BPS;
      const maxHold = mode === 'late' ? LATE_HOLD_BARS : WASHOUT_HOLD_BARS;
      const takeAt = (cost * BigInt(10000 + takeBps)) / 10000n;
      const stopAt = (cost * BigInt(10000 - HARD_STOP_BPS)) / 10000n;
      if (value >= takeAt || value <= stopAt || holdBars >= maxHold) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        lastExitSeq = state.seq;
        everTraded = true;
      }
      return orders;
    }

    if (stopped || state.seq >= LAST_ENTRY_BAR || state.seq - lastExitSeq < COOLDOWN_BARS) return orders;

    const washoutHigh = rollingHigh(WASHOUT_BARS);
    if (
      washoutHigh !== null &&
      dipBps(washoutHigh, close) >= WASHOUT_DIP_BPS &&
      upBars >= 1
    ) {
      const slice = state.cash;
      if (slice >= BigInt(state.hello.fees.min_notional_quote_units) && slice > 0n) {
        pendingMode = 'washout';
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
      return orders;
    }

    if (!everTraded && state.seq >= LATE_BAR) {
      const lateHigh = rollingHigh(LATE_BARS);
      if (
        lateHigh !== null &&
        dipBps(lateHigh, close) >= LATE_DIP_BPS &&
        upBars >= 2
      ) {
        const slice = (state.cash * BigInt(LATE_SIZE_BPS)) / BPS;
        if (slice >= BigInt(state.hello.fees.min_notional_quote_units) && slice > 0n) {
          pendingMode = 'late';
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }
    return orders;
  },
});
