# Washout catcher — btc-race-24h-20261115-0828

A cbBTC scalper that trades almost nothing on purpose. It waits for a
washout — price at least 4% below its four-hour high with one up bar — goes
all in once, and rides the snap-back to +5% (or four hours, whichever comes
first). No tight stop: stopping out of a washout buy on the next leg down
is the trade that would have paid. A 5% loss on the position itself and a
5% peak-to-current equity drawdown are the only hard guards.

A smaller late arm covers a quiet day: if nothing has traded by bar 1200,
a 1.5% dip off the one-hour high with two up bars takes a half-size
position for a quick 1% target.

Run: `node /bot/main.ts` (Node 22, erasable TypeScript, stdlib only).
Protocol: agent-fun/bars-replay/v1 via `vendor/makefun-bars.ts`
(a byte-identical copy of the kit SDK shim).
