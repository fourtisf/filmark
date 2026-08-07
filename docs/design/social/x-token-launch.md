# Token launch copy

Ticker is `$FILL` — the reasoning is below. Everything still in `{BRACES}` is a
fact only you have: contract, supply, venue, date, and the distribution numbers.
Those are the things a reader acts on with money, and inventing any of them to
make a draft read smoothly is the one kind of filler that costs somebody else.

---

## The ticker: `$FILL`

**Your own wordmark already argues for it.** The lockup renders `FILL` at weight
700 in white and `MARK` at weight 300 in grey — the brand has been emphasising
the first half on every page since before there was a token. A ticker that is
already the bold half of your logo needs no explaining and no redesign.

It is also the right word rather than a convenient one. A *fill* is an executed
trade, and the product's single idea is that every fill had another side. "Who
took the other side of your fill" is the pitch, the domain name and the ticker
in one syllable. Four letters, one pronunciation, nothing to spell out loud.

**The alternatives, and why not:**

- `$MARK` — the other half of the name, and in con-artist usage a *mark* is the
  person being taken. For a product whose audience is people who were extracted
  from, that is a joke landing on the wrong person.
- `$EXIT` — from `@exitliquidity`, the repo's own namespace. It names the
  problem well, but it is generic, already crowded on Solana, and it is the
  audience's failure rather than the product's function.
- `$FLMK` — survives any collision check and nothing else. Unpronounceable
  tickers get typed wrong, and a mistyped ticker on a DEX is somebody buying the
  wrong token with your name on the receipt.

**Check the collision before you commit.** `$FILL` is short and short tickers
collide; search it on a DEX aggregator and on the major Solana screeners first.
A collision is not fatal — the contract address is what people trade — but it
decides whether search sends people to you or to somebody else.

---

## Read this before the copy

This product's whole position is that it will not state what it did not measure.
That is the reason to trust it, and a token launch is the moment it is most
easily thrown away — one "100x" post and every §7.4 line on the site reads as
marketing that happened to be true so far.

The audience makes it sharper. Fillmark exists for people who got extracted from
by memecoins. They have read a thousand launch threads and they can identify a
hype cadence in one line. Copy that sounds like the last token that took their
money is copy that argues against the product, no matter what it says.

So the register below is the same one the console uses: specific, bounded, and
noticeably unexcited. It reads as underselling. That is the point — it is the
only tone this particular audience has not been burned by.

**Nothing here mentions price, market cap, returns, "early", or what the token
might be worth.** That is not caution for its own sake: promising or implying a
return is what turns a launch post into a financial promotion, and in most
jurisdictions that is a regulated act with your name on it. Say what the token
*does*. Let the reader do the arithmetic.

---

## The one decision the copy cannot make for you

Every line below assumes the token buys **access** — that it is the way to hold
Pro (`$29/month` on the site today: unlimited traces, pre-trade check,
distribution alerts, watchlists, CSV and API).

That is the only utility this repo can actually support, and it is a good one,
because it is checkable: somebody can hold the token and use the thing. If your
token is instead governance, a fee share, or a pure memecoin, **stop and tell
me** — the copy changes completely, and the third of those cannot honestly use
any of the utility language here.

---

## 1 · Announcement, before launch

**Banner:** `x-post-1.png` or `x-banner-d.png`

```
$FILL launches {DATE} on {VENUE}.

It does one thing: it holds your Pro access to Fillmark — unlimited traces,
pre-trade checks, distribution alerts, and the API.

The engine is live at fillmark.xyz. Trace a wallet before you decide
anything about the token.
```

_Why this order:_ the product is named before the token is. A reader who tries
the trace first arrives at the token having already seen something work, which
is a different conversation from arriving at a chart.

---

## 2 · Launch thread

**2/1 — what it is** · `x-post-1.png`

```
$FILL is live: {CONTRACT}

It is the access key to Fillmark — Solana counterparty forensics. Paste a
wallet, and every position you closed in the red is netted against the
wallets that were selling into the same windows.

fillmark.xyz
```

**2/2 — what holding it does** · `x-post-5.png`

```
What $FILL does, in full:

→ Hold {AMOUNT} $FILL — Pro is unlocked while you hold it
→ Unlimited traces instead of three a day
→ Pre-trade check before you enter a pool
→ Alerts when a wallet on your list starts distributing
→ API and CSV

Sell it and you are back on the free tier. That is the whole mechanism.
```

**2/3 — the product, not the token** · `x-post-2.png`

```
The part that took the work:

Every closed position is rebuilt with FIFO accounting. For each one that
closed in the red, the pool's own history is crawled around your entry, then
your buy is netted against the wallets that were selling into that window.

Pump.fun and PumpSwap. Both venues, one position.
```

**2/4 — the honesty, which is the moat** · `x-post-3.png`

```
And it tells you what it could not read.

$8,140 attributed. $2,306 that no window explained — reported separately,
never folded into the headline. The two add up to the realised loss.

Attribution measures overlap, not payment. That limit is printed on every
trace, not buried in a docs page.
```

**2/5 — the terms** · `x-banner-b.png`

```
Terms, so nobody has to ask:

→ Supply {SUPPLY}, no mint authority
→ Team holds {TEAM_%}, {VESTING}
→ Liquidity {LP_AMOUNT}, {LOCKED_UNTIL}
→ No presale, no allocation, no private round   ← only if true

{CONTRACT}

Verify all of it on-chain before you believe any of it.
```

**2/6 — the one nobody else can post** · `x-post-3.png`

Optional, and the strongest post in the thread. See section 5 for why.

```
Last: here is $FILL's own deployer wallet, traced with Fillmark.

{PASTE THE REAL COVERAGE BLOCK — census, positions, attributed, unattributed,
and whatever it could not read}

It reports its limits on us the same way it will on you.
```

---

## 3 · Launch-day single post

For anyone who will not read five posts.

```
$FILL is live. {CONTRACT}

It unlocks Pro on Fillmark: paste a wallet, see every position you closed in
the red and the wallets that were selling into it.

The tool works whether or not you hold the token. Try it first.

fillmark.xyz
```

---

## 4 · Lines to never use

Not a style preference. The first four are financial promotion; the last three
are the ones this specific audience punishes hardest.

| Do not write                       | Why                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------- |
| "100x", "early", "don't miss"      | A return claim. Regulated in most places, and your name is on it          |
| "guaranteed", "risk-free"          | False for every token that has ever existed                               |
| "next {SOMETHING}"                 | A comparison to a price history you cannot repeat                         |
| "floor price", "we will support"   | A promise about a market you do not control                               |
| "revolutionary", "game-changing"   | Says nothing, and reads as a template                                     |
| "community-driven", "we are early" | The exact cadence of the tokens that extracted from your audience         |
| Countdown timers, 🚀, "LFG"        | The product's tone is austere on every other surface; this breaks it      |

---

## 5 · The one thing worth adding that nobody does

Trace the token's own deployer wallet with your own tool, and post the result —
whatever it says.

If it is clean, that is the strongest thing you can publish and it costs
nothing. If it is not, you have found it before somebody else did, on a wallet
you control. Either outcome is better than the version where you did not look.

It is also the only launch post that demonstrates the product on itself, which
is worth more than five posts describing it.

---

## Before any of this goes out

- **The site currently promises "no launch sequence"** on the waitlist form.
  That is about email, not about tokens, but the same people read both. If
  $FILL is announced by email, that line has to change first or it becomes a
  broken promise with a screenshot attached.
- **The trace has to answer.** Post 2/3 and 2/4 invite people to paste an
  address. While the crawl is throttled, active wallets come back
  `unreadable_history`. A launch that sends its largest-ever traffic spike at a
  throttled RPC key is a first impression you only get once — get a wallet
  answering from `swap index` first.
- **Only the Trace tab is live.** Nothing above mentions the index, lead-time,
  watchlist or receipt surfaces, because they still carry demo data. Do not add
  them to the token's utility list until they are real; a utility list is a
  promise with a price attached to it.
