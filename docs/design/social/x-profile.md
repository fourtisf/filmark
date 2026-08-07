# X profile — header and bio

Headers from `node scripts/build-x-header.mjs`. Four candidates at 1500×500,
and `x-banner-preview.png` shows each one with the avatar drawn where X punches
it through, at the two widths a profile is actually seen at.

Two constraints, and only the second is obvious:

- X puts the avatar circle through the bottom-left — roughly x 0..380, y 330..500.
  Every candidate here ends its content by y=320 and treats the bottom strip as
  somebody else's.
- The header keeps its 3:1 ratio and **scales down** on a narrow viewport rather
  than cropping. So a 15px caption that reads on a desktop profile is 7px on a
  phone, which is why the preview has a phone column and why it is the one that
  decides.

---

## Recommendation: **D — the flow**

Left, what you closed at a loss. Right, the wallets that were reducing supply
into the same windows. Between them the ribbons the console actually draws,
thick where the value left.

It is the only candidate that says what the product *does* before the bio gets a
chance to, and it is the only one whose graphic survives the phone column intact
— because it is three heavy shapes rather than a detail. It is also the product's
own diagram rather than an illustration of it, which is the difference between a
header that looks designed and one that looks like the thing it advertises.

**If you want numbers instead: B — the answer, as a strip.** Realised,
attributed, unattributed and the window, in the console's own type. It puts the
one genuinely unusual behaviour — reporting what could not be explained beside
what could — on the first surface anybody sees. Labelled illustrative on the
banner, for the same reason the thread's third frame is.

**If you want restraint: C — the centred lockup.** The mark at a size a header
can carry, symmetric so the scale-down takes the same off each side. Nothing
about the product, which is a choice rather than an oversight.

**A — the window** is the mechanism drawn out: your buy, the window either side,
the sells that overlapped it. It is the clearest teaching image of the four and
the weakest on a phone, where the two captions go under 8px and stop being
words.

---

## Bio

160 characters is the ceiling. All three fit with room, and none of them claims
proof, identity or recovery — the same line the product holds everywhere else.

**Recommended — what it does, in its own words (122 chars):**

```
Solana counterparty forensics. Every position you closed in the red, netted
against the wallets that were selling into it.
```

**Sharper, leads with the hook (127 chars):**

```
Your losses didn't evaporate. They moved. Fillmark reads Solana and names the
wallets that were on the other side of your fills.
```

**Leads with the limit, which is the differentiator (134 chars):**

```
Solana counterparty forensics. Attribution measures overlap, not payment — and
every trace ships with what it could not read.
```

### The rest of the profile

- **Website:** `fillmark.xyz` — X renders this as its own field, so keep it out
  of the bio and spend the characters on the sentence.
- **Location:** leave empty. A forensics tool with a city under it invites a
  question nobody wants to answer.
- **Name:** `Fillmark`. Not "Fillmark | Solana Analytics" — the bio already says
  what it is, and a pipe in a display name is the oldest tell in the category.
- **Pinned post:** post 1 of the introduction thread, so the profile opens on the
  hook rather than on whatever shipped most recently.
