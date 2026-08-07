# X introduction thread

Five posts, one banner each, from `node scripts/build-x-posts.mjs`.

Register: scannable, not literary. A launch thread is read at speed on a phone,
so every post leads with its point, breaks into short lines, and stands alone if
somebody meets it out of order. No emoji — this is a forensics product, and the
brand is austere everywhere else.

Two rules shaped every line, and they are the same two the product runs on.

**§7.1** — nothing claims proof, identity or recovery. Attribution measures
overlap, and post 4 says so before anybody has to ask.

**§7.4** — no figure anywhere is presented as a measurement of a real address.
One frame shows a mocked coverage block, labelled illustrative on the frame, so
a reader can see the shape of a full answer. What stays out is a headline number
with nothing behind it: "$2.1M traced" is the post this thread does not have.

---

## 1 · Hook

**Banner:** `x-post-1.png`

```
Your losses didn't evaporate. They moved.

Every position you closed in the red had someone on the other side of it.
On an AMM, that someone is a wallet reducing supply into the same window
you were buying in.

Fillmark reads Solana and names them.

fillmark.xyz
```

_Alt text:_ Fillmark wordmark over the line: your losses didn't evaporate, they
moved.

---

## 2 · How it works

**Banner:** `x-post-2.png`

```
How it works:

→ Paste any wallet address
→ Every closed position is rebuilt with FIFO accounting
→ For each one that closed in the red, it crawls the pool's own history
   around your entry
→ Then nets your buy against the wallets that were selling into that window

Pump.fun and PumpSwap. Both venues, one position.
```

_Alt text:_ A buy leg with a time window either side of it, and the sells that
overlapped it.

---

## 3 · What makes it different

**Banner:** `x-post-3.png`

```
Most tools hand you a number and let you assume it's complete.

This one shows its work:

$8,140  attributed
$2,306  that no window explained — reported separately
$10,446 realised loss

The two add up. Nothing is padded to make the headline bigger.
```

_Alt text:_ A coverage table — $8,140 attributed, $2,306 unattributed, against a
realised loss of $10,446.

---

## 4 · The limit, stated up front

**Banner:** `x-post-4.png`

```
Before you read the list, read this:

Attribution measures overlap, not payment.

On an AMM you trade against a pool, not a person. These are the wallets
that were reducing supply into your windows, weighted by size and by how
close they sat to your fill.

A strong signal. Not a receipt, and not an accusation.
```

_Alt text:_ The line: attribution measures overlap, not payment.

---

## 5 · The ask

**Banner:** `x-post-5.png`

```
No wallet connection. No signature. No extension.

One address in, and you get:

→ Every position you closed
→ The window around each entry
→ The wallets that were on the other side
→ An honest account of what the read could not reach

fillmark.xyz/app
```

_Alt text:_ A wallet address field with a Trace wallet button.

---

## Two alternates for post 1

The hook is the only post most people will see, so it is worth having options.
Both use the same banner.

**Sharper, shorter — for a colder audience:**

```
Somebody was on the other side of every trade you lost.

Fillmark reads Solana and names them.

fillmark.xyz
```

**Concrete, for people who already trade memecoins:**

```
You closed the position at −$10,446.

That value did not disappear. It went to the wallets that were selling
into the window you bought in — and on Solana, those wallets are on the
record.

Fillmark reads them back to you.

fillmark.xyz
```

---

## Before this goes out

- **Do not move post 4 to the end.** Leading with a list of who took your money
  and burying the caveat is the version of this thread that gets called a scam
  by the first person who reads the method. Stating the limit in the same voice
  as the claim is what makes the other four credible.
- **Only the Trace tab is live.** The console's other five tabs are drawn but
  still prototype, and the index and lead-time pages carry demo data. Nothing
  above mentions them, deliberately. Say them out loud once real data is behind
  them, not before — that walk-back costs more than the wait.
- **Post 5 invites people to paste an address.** While the crawl is throttled,
  active wallets come back `unreadable_history`. First impressions happen once;
  wait until a wallet answers from `swap index` before this thread goes up.
- **The banners are 1600×900.** X crops to 16:9 in the timeline, so nothing is
  lost. `x-post-preview.png` shows each frame at the ~380px a phone renders,
  which is the size to judge them at.
