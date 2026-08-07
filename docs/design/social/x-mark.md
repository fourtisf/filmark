# X profile mark

Five candidates, rendered by `node scripts/build-x-avatar.mjs`. Masters are
1000×1000 PNG, `x-mark-<key>-dark.png` and `-light.png`.

Two sheets decide it, and only the second one is evidence:

- `x-mark-preview.png` — every candidate at 400 / 112 / 48 / 32px, circular, on
  both timelines. Useful, but the browser resamples a 1000px master into
  something smoother than a timeline ever produces.
- `x-mark-pixels.png` — rasterised **at** 32 and 48px, then magnified 7× with
  nearest-neighbour. This is the pixel grid X actually hands a reader. A 4px
  stroke that lands across two pixel rows comes back grey here and nowhere else.

---

## Recommendation: **A — the overshoot**

An F's lower arm is always shorter than its upper one. This one is longer, and
that inversion is the only unusual thing about the glyph — which is why it is
the thing that gets remembered. It is also the product in one shape: the row
that closed in the red went further than the row above it, and it went right.

It wins on the sheet that matters. Every edge is orthogonal, so at 32px it
rasterises to hard pixels with no grey fringe, and the accent is the largest
element in the circle — which is what buys recognition in a timeline where the
mark is 32px next to a hundred others.

**Second choice: C — the ribbon.** The arms taper the way the console's own flow
diagram does, thick where the value leaves and thin where it lands. At 112px, on
the profile page where somebody decides whether to follow, it is the only one of
the five that looks drawn rather than assembled. It costs a little crispness at
32px, where the tapered tips antialias to grey. Choose it over A if the profile
page matters more to you than the timeline.

## The other three, and why not

**B — weighted arm.** Attached, heavier than the arm above it, shorter. Legible
at every size and survives embroidery and a favicon. Also unremarkable: it is
the current mark with better proportions, and it says nothing A does not say
louder.

**D — cut terminal.** Both arms end on a 45° chamfer, which gives the glyph a
direction it does not otherwise have. Handsome at 400px. At 32px the diagonals
are the problem — they land as grey stair-steps, and the mark goes soft exactly
where the others stay hard.

**E — notch.** The letter as negative space in a solid slab. It is the only
candidate that reads as a *logo* rather than as a letter, and the pixel sheet
kills it: at 32px it is a white brick with two black bars, closer to an E than
an F, and on a light timeline it is a dark block with no silhouette at all. Kept
in the set because the sheet showing it fail is worth more than a description of
why it might.

---

## Notes

- **Nothing crosses r=440** from centre on the 1000px field. X crops to a circle
  and does not warn you.
- **Stroke is 132 units**, which is 4.2px at 32px. The mark in `build-social.mjs`
  used 120, which sits right on the edge of surviving.
- **No gradient, no bevel, no glow.** Every one of those reads as a token logo,
  and this product's entire pitch is that it is not one.
- The site's own mark is separate and unchanged — it lives in
  `scripts/logo-marks.mjs` and is applied by `scripts/set-logo.mjs`. Adopting one
  of these as the product identity everywhere is a different decision from
  picking a profile picture, and it has not been made here.
