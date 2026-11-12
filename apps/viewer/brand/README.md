# Agency brand for the client viewer (optional)

The viewer can carry an agency's look: its colours, its fonts, its name in the header and a "Prepared by" line in the footer. It is chosen **when the viewer is built**, from a small folder. With no folder, the viewer keeps the look it has always had.

## How to use it

1. Copy `brand.example.json` to `brand.json` in this folder and edit it, or point `WEBOBS_BRAND_DIR` at a folder that holds a `brand.json` (and a `fonts/` folder).
2. Optional fonts: put Latin-subset `.woff2` files in `fonts/` named like the entries in `brand.json` (`Oswald.woff2` for `"file": "Oswald.ttf"`; a `.ttf` of the same name also works but is larger). They are embedded in the page: no font service is called. Use fonts whose licence lets you ship them (the SIL Open Font License does) and keep the licence text with them.
3. Build as usual (`npm run build`, or the Docker build). The build prints which brand it used, the fonts embedded, every contrast ratio, and any warning. Set `WEBOBS_BRAND_STRICT=1` to make an invalid brand fail the build instead of falling back. `WEBOBS_BRAND=off` forces the built-in look.

`brand.json` and `fonts/` are ignored by git on purpose: an agency's brand is its own. Only `brand.example.json` (neutral) is tracked.

## The file

The keys follow the structure of an agency brand profile, so the same file can later come from that record, and new keys can be added without breaking the build. Unknown keys are kept and ignored.

| Key | Used now | Notes |
|---|---|---|
| `schema_version` | yes | `1`. Optional. |
| `name` | yes | Required. The agency name. |
| `colors` | yes | `primary` and `text_on_dark` are required (`#rrggbb`). Also `blue_dark`, `blue_light`, `tint`, `accent_orange`, `text`, `grey_2`, `surface`, `muted`, `grid`. **`grey_0` and `grey_1` are reserved for visibility** (see below): valid keys, but never applied. |
| `fonts.heading` | yes | `{ name, file, case }`; `case` is `uppercase`, `none`, `capitalize` or `lowercase`. |
| `fonts.body` | yes | `{ name, regular, bold }`. |
| `attribution` | yes | Optional `{ header_text, footer_text }`; default from `name` ("Prepared by ..."). Text only, no logo. |
| `logo` | no | Optional file path; ignored (attribution is text). |
| `voice_context`, `audience`, `source`, `voice`, `avoid_words`, `negation_max_per_100_words`, `preferences` | checked, not rendered | Carried and type-checked; never put in the page. `avoid_words` and `negation_max_per_100_words` drive the wording report below. |

## What the colours do

On the dark viewer: the page and the 3D stage keep the original dark (`#07090f`, reserved), `surface` (or, without it, `grey_2`) colours the panels and cards, `text_on_dark` the text, `accent_orange` (or `primary` if absent) the buttons and highlights, `primary` the agency name and links, `blue_light` the expandable sections. The build checks contrast and nudges what is too faint: `muted` is lightened until small text reads at 4.5:1 on the page and on panels; `primary` is lightened for links if needed; text on a button is dark or white, whichever reads better. A client's own colour in a report (its `client.accent` and `client.theme`) still wins over the agency brand.

## Reserved for visibility

A brand can never change two things, so the 3D map always reads clearly:

- **The page and 3D stage background** is the original dark `#07090f` in every build, with or without a brand, on every screen (welcome, steps, feedback, loading, error) and on the server's refusal page. The contract keys `grey_0` and `grey_1` (the page greys) stay valid in `brand.json` so the file keeps the home contract's shape, but they are **not applied**; the build prints one plain message naming them. A report's own `client.theme` background is ignored for the stage too.
- **The 3D render** (the globe, its dots and center dot, its palette) comes from the globe component and is out of reach of a brand.

Everything else stays branded: panels and cards, text, accents, fonts, header and footer. Contrast is checked against the ORIGINAL background and the card colour (text, muted text, links, the accent, text on buttons) and faint colours are nudged until they pass.

## Wording report

`node apps/viewer/brand/scan-wording.mjs [brand-dir]` reads the visible text the viewer ships and lists strings that contain `avoid_words` and how many negations there are per 100 words. It only warns; it never blocks a build.

## Checks

`node apps/viewer/brand/test-brand.mjs` covers valid, missing and invalid brands, unknown keys, the fallback, contrast, and that a built page has no external font or script address.

## Card colour: `surface`

`surface` is an optional key that expands the home contract's colours: the background of cards and panels. Use it to pick any card colour without touching `grey_0` and `grey_1`, which stay reserved for the page and 3D stage. Without `surface`, cards use `grey_2`, then a derived grey. A branded card also gets a thin edge line (the text colour at 28 percent) so a dark card still reads against the original dark page; the build checks that the edge shows against the card and against the page.

## Header and the agency name

The viewer header shows the client's name (and the client's own logo if the report has one). The agency name is shown once, in the footer line. `attribution.header_text` is still accepted in `brand.json` and is ignored.

## A look carried by a report (v0.1.4)

A report can also carry its own look, so nothing has to be built: see `docs/STYLES.md`. The build-time brand described above stays as a fallback; a report's look replaces it.

### Text on cards: `cardText` and `cardMuted` (v0.1.6)

A report's look can also set `cardText` and, optionally, `cardMuted`: the text and the small text on cards and panels, so a light card can carry dark text. They are optional slots of the look, not keys of `brand.json`. Both are checked for readability (4.5:1) when the report is uploaded and again when it is served. See "Text on cards" in `docs/STYLES.md`.
