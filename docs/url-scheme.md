# URL scheme

Spec §4 makes the public pages the entire organic acquisition strategy, and
that strategy is one indexable page per entity. This is the route table P3
builds against.

Nothing here is implemented — the prototypes are four static files. It is
written down because the shape of these routes decides how P3 renders, and
changing it after pages are indexed costs the link equity that is the whole
point.

## Routes

| Route                                   | Page            | Index? | Notes                                                |
| --------------------------------------- | --------------- | ------ | ---------------------------------------------------- |
| `/`                                     | Landing         | yes    |                                                      |
| `/index/7d`, `/index/30d`, `/index/90d` | Extractor index | yes    | Window in the path, not a query string               |
| `/lead-time`                            | Lead-time radar | yes    |                                                      |
| `/token/<mint>`                         | Token receipt   | yes    | The volume play. One per token that clears the floor |
| `/extractor/<address>`                  | Extractor file  | yes    | The other volume play                                |
| `/app`                                  | Console         | **no** | No stable content behind a paste box                 |
| `/trace/<address>`                      | Wallet trace    | **no** | See below                                            |
| `/receipt/<trace-id>.png`               | Receipt card    | n/a    | Served as an image, referenced from OG tags          |

## Why the window belongs in the path

`/index?w=30` and `/index?w=7` are one URL to a crawler unless every
combination is declared canonical separately, and even then the ranking signal
splits badly. Three paths are three pages, each canonicalising to itself, each
able to rank for its own phrasing ("biggest Solana extractors this week").

The prototype demonstrates this: the window buttons push a real URL and the
canonical tag follows.

## Why `/trace/` is noindex

A trace is public chain data, so there is no legal reason to hide it. There is
a product reason. A ranking page says "these wallets took the most out of
Solana this month" — that is analysis. A trace page says "this address lost
$18,412" — that is one person, and being the first search result for their
address is not a position worth holding.

Traces stay linkable and shareable. They just do not get crawled.

## Floor for a generated page

Thin pages at volume are how a site gets classified as a content farm. A token
or extractor page ships only when it has something to say:

- **Token receipt** — at least 50 wallets with a closed position, and at least
  one attribution row. Below that the page is a stub with no answer on it.
- **Extractor file** — at least 20 attributed counterparty rows across at least
  5 pools. One lucky trade is not a profile.

Everything below the floor still resolves, but renders a short "not enough
history yet" state and carries `noindex` until it clears.

## Language on generated pages

Rule §7.1 does not relax because a page is machine-generated. A title reads
`9mQr…4kR8 — $2.14M attributed`, never `9mQr…4kR8 took $2.14M`. That
distinction is the product's whole defensibility and it has to survive
templating.

## Canonical and pagination

- Every page declares a self-referencing canonical.
- The index is capped at 100 rows and does not paginate. If it ever does,
  page 2+ carry `noindex,follow` rather than `rel=prev/next`.
- Token and extractor pages canonicalise on the lowercase address; a
  mixed-case request 301s to it.
