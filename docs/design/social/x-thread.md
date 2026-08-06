# X introduction thread

Five posts, one image each, written against the frames in `x-post-1..5.png`
(`node scripts/build-x-posts.mjs`).

Two rules shaped every line below, and they are the same two the product runs
on.

**§7.1** — nothing claims proof, identity or recovery; attribution measures
overlap and the copy says so before anybody has to ask.

**§7.4** — no figure anywhere is presented as a measurement of a real address.
That is what the rule is actually about, and it leaves room for the thing every
product does: one frame shows a mocked coverage block, labelled illustrative on
the frame, so a reader can see the shape of a full answer. What stays out is a
headline number with nothing behind it — "$2.1M traced" is the post this thread
does not have.

Post 4 is load-bearing. Leading with a list of "who took your money" and
burying the caveat is the version of this that gets called a scam by somebody
who reads the method; stating the limit in the thread, in the same voice as the
claim, is what makes the rest credible. Do not reorder it to the end.

---

## 1 · Hook

**Image:** `x-post-1.png`

```
Your losses didn't evaporate. They moved.

On an AMM there is always another side of your fill. When a position
closes in the red, that value went somewhere — to whoever was reducing
supply into the same window you were buying in.

Fillmark reads Solana and names them.

fillmark.xyz
```

---

## 2 · What it does

**Image:** `x-post-2.png`

```
Paste a wallet. It reads the chain, rebuilds every closed position FIFO,
and for each one that closed in the red it crawls the pool's own history
around the entry — then nets the buy against the wallets that were
selling into that window.

Pump.fun and PumpSwap today. Both venues, one position.
```

---

## 3 · The part nobody else ships

**Image:** `x-post-3.png`

```
Every answer carries what it could not read.

$8,140 attributed. $2,306 that no window explained — reported beside the
headline, not inside it. Both add up to the loss the wallet actually
realised, which is the point: nothing is padded to make the number bigger.

The window it reached is printed too, not the one it asked for.
```

The figures on that frame are illustrative and the frame says so. They are also
internally consistent — 8,140 + 2,306 = 10,446 — because the first person to add
them up is the person worth convincing.

---

## 4 · The limit, said out loud

**Image:** `x-post-4.png`

```
Read this before you read the list.

Attribution measures overlap, not payment. On an AMM you trade against a
pool, not a person — these are the wallets that were reducing supply into
the same windows, weighted by size and proximity.

That is a strong signal. It is not a receipt, and it is not an accusation.
```

---

## 5 · The ask

**Image:** `x-post-5.png`

```
One input. No wallet connection, no signature, no extension.

Paste an address and you get the closed positions, the windows around
them, the wallets on the other side — and an honest account of what the
read missed.

fillmark.xyz/app
```

---

## Notes for whoever posts this

- **Only the Trace tab is live.** The console's other five tabs are drawn but
  still prototype, and the index and lead-time pages carry demo data. Nothing
  above mentions them, deliberately. Say them out loud only once real data is
  behind them — that is the same §7.4 line the product holds itself to, and it
  costs more to walk back than to wait for.
- **Alt text** is not optional on a thread whose whole argument is legibility.
  Suggested, in order: "Fillmark wordmark over the line: your losses didn't
  evaporate, they moved" / "A buy leg with a time window either side of it, and
  the sells that overlapped it" / "A coverage table: $8,140 attributed, $2,306
  unattributed, against a realised loss of $10,446" / "The line: attribution
  measures overlap, not payment" / "A wallet address field with a Trace wallet
  button".
- **The banners are 1600×900.** X crops to 16:9 in the timeline, so nothing here
  is lost; the contact sheet in `x-post-preview.png` shows each frame at the
  ~380px a phone renders, which is the size to judge them at.
