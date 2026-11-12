# Giving a report its own look (styles)

From version 0.1.4 a report can carry its own look: colours, two fonts and the agency name. The image holds no brand, nothing is built, and a report without a look keeps today's built-in look.

## The styles file

A small, flat JSON file. Every name is optional; a name that is left out changes nothing.

```json
{
  "accent": "#F2994A",
  "surface": "#101010",
  "text": "#C4C4C4",
  "muted": "#7C7C7C",
  "link": "#23AEEB",
  "secondary": "#2ECDF5",
  "headingFont": "Oswald",
  "bodyFont": "Inter",
  "headingCase": "uppercase",
  "name": "Example Agency",
  "footerText": "Prepared by Example Agency"
}
```

| Name | What it does | Accepts |
|---|---|---|
| `accent` | buttons, the progress dots, highlights; text on a button turns dark or light by itself | `#rrggbb` |
| `surface` | the background of cards and panels (with a thin edge line) | `#rrggbb` |
| `text`, `muted` | the text on the dark page and, when there is no `cardText`, also on the cards; faint colors are lightened so they read | `#rrggbb` |
| `cardText`, `cardMuted` | optional (0.1.6): the text and the small text ON CARDS and panels, checked against the card color only. Use them for a light card with dark text, or any card where the page text does not suit. `cardMuted` defaults to a softer shade of `cardText` | `#rrggbb` |
| `link` | links and the name in the header area (defaults to the accent) | `#rrggbb` |
| `secondary` | the expandable explanation headings | `#rrggbb` |
| `headingFont`, `bodyFont` | a font from the bundled list (`Oswald`, `Inter`) | those names only |
| `headingCase` | capital letters in headings | `uppercase`, `none`, `capitalize`, `lowercase` |
| `name` | the agency name in the browser title | plain text, up to 80 characters |
| `footerText` | the one line at the bottom naming who prepared the report (defaults to "Prepared by" and the name) | plain text, up to 120 characters |

The header shows the client's name (and the client's own logo if the report has one). The agency is named once, in the footer line.

**Never changed by a look:** the page and 3D stage background (always the original dark `#07090f`) and the 3D map colours. There is no name for them, so a file that tries is refused. A report's own `client.accent` and `client.theme` still win over the look.

**Size:** the file is at most 4096 characters (a real one is about 250). A page with the two bundled fonts grows by about 80 KB.

**Everything in a styles file is visible to anyone who has the report link.** Put no private notes or contact details in it.

## Checking a file

```
node apps/server/tools/check-styles.mjs my-look.json
docker run --rm -v "$PWD:/work:ro" IMAGE node tools/check-styles.mjs /work/my-look.json
```

It prints the pairing hash, the names used, every readability ratio, what was adjusted and the size the page grows by. Exit code 1 means the upload would be refused. Nothing is sent or stored.

## Publishing a report with a look

- **Studio:** the Brand & review tab has **Look (styles file)**. Choose the file; the Studio checks it, and Publish or Save carries it in the report. The accent field there still works and wins over the look's accent.
- **Command line:** `node apps/server/scripts/export-client-report.mjs <_site-graph.json> --approve-as "Name" --styles my-look.json`, then `npm run publish:client` as before.
- **By hand:** `node apps/server/tools/make-envelope.mjs report.json my-look.json > body.json`, then send `body.json` to the ingest route as usual.

The upload is **one request with two named parts**: `styles_<hash>` and `data_<hash>`. The hash is the first 12 hex characters of the SHA-256 of the styles in a fixed form. The ingest recomputes it and refuses a mismatch, a duplicate name, a missing part or a third part. A plain report (no look) is accepted exactly as before.

The ingest stores one file: the report with the checked look inside it. The look has the same lifetime as the report and goes with its cleanup.

## What the viewer does

The report server checks the look again when it serves the page and writes it into the first bytes of the page (a generated style, the title and a small data block), so the page opens already in its look. If a look does not pass the second check, the report is served in its neutral look and the server logs a reason code (never the contents). Browsers keep nothing: every response is `no-store`.

The page holds its first draw for up to about a second and a half so the heading font is ready; if it is not, the page appears anyway.

## Updating a look

A look travels with its report, so old links keep the look they were published with. To change it, publish the report again with the new file: the new upload gets a new link, and the old link can be revoked.

## Text on cards (0.1.6)

The page is always dark (`#07090f`), so `text` and `muted` are lightened until they read on it. In 0.1.5 the same text was also used on the cards, so a light card with dark text could not be expressed: the dark text was lightened for the page and then no longer read on the light card.

From 0.1.6 a look can say what the text on the cards is:

- With **no** `cardText` nothing changes: one text color for the page and the cards, exactly as in 0.1.5 (a test compares the page variables of eight looks with 0.1.5's).
- With `cardText`, the text on cards is that color, checked against the card color (`surface`) only. The page text (`text`, `muted`) is checked against the dark stage only. Links and the second color on cards are checked against the card.
- A `cardText` that does not reach 4.5:1 on the card is **refused**, with the colors and the numbers and a suggestion, for example: `cardText: #323334 on the card #d52924 reaches only 2.52:1 and needs 4.5:1. Use light text on this card, for example #ffffff (5.0:1).`
- A `text` that is too dark for the dark page is not refused: the page uses a lightened color, and the check tool says so with the numbers: `text #323334 reaches 1.57:1 on the dark page (needs 4.5:1), so the page uses #7a7a7b instead`.
- Without `cardText`, a light card is still refused, and the message tells you to set `cardText`.
- Old styles files stay valid, and a look with a dark card renders exactly as before. One thing is not "as before": since 0.1.5 a stored look whose card color cannot be read with the page text (for example a light card without `cardText`) is no longer applied. The viewer server shows the neutral look for it and logs `styles-unreadable`. Adding `cardText` to the look (and publishing again, or re-saving the report with it) brings the look back.
- The severity chips (high, medium, low), the warning chip and the warning and "Keep in mind" boxes have fixed colors made for the default dark card. On a card where those do not read (a light card, a red card) the look gets its own pairs for them, computed from the card color and the card text, and a light card also gets dark-on-light borders. The checks list these pairs as `the high severity chip on a card` and so on.

### The card as drawn, and the small text on it (0.1.7)

- **Cards are drawn opaque when the text on them is darker than the card.** The viewer draws its cards at 82 to 90 percent of the card color over the dark page, so the card on screen is a little darker than the color you set. That only helps light text, but it lowered dark text on a light card by about 10 percent (a checked 4.7:1 read about 3.8:1). From 0.1.7, when the card text, the muted text, the links or the second color is darker than the card, the cards are drawn at full opacity, so the color that is checked is the color that is on screen. A dark or mid-tone card with light text keeps the glass look.
- **Built-in colors on a light or red card.** When a look sets a card color but not the muted text, the second color or a link/accent color, the built-in ones show on that card (made for the dark card). On a card that is not dark they are now nudged toward the card text until they reach 4.5:1 (the check tool lists what it adjusted). A dark card keeps the built-in colors exactly as before.
- **The muted label chips** (Fetched, Raw, Lab) are the muted text on a faint tint. The tint lowered their ratio (3.3 to 4.1:1 on some looks), so the chip now gets its own text color, the muted text pushed toward the card text until it reads on the chip (4.5:1 or better). It is written as `--rp-card-label-fg` and only when the muted text does not already read there.
- **A mid-tone card that needs dark text** (for example a card around #808080 with dark text) has no tint that reads, so its severity chips and warning boxes fall back to no tint at all: they show the chip text on the card itself. They read, but they look grey instead of colored. This is the last resort and is expected.
- The browser test measures, inside the tour card, the severity chips, the warning chip and box, the caveat, the plain chip, the muted label chips, a link, the second color and the muted text for a light card, a red card and the default dark look: all at 4.5:1 or better.

## A look must be readable

The page keeps text readable by nudging: a `text`, `muted`, `link` or `secondary` colour that is a little too dim is moved toward the readable end (the check tool lists what it adjusted). Nudging cannot help when the **card colour** (`surface`) itself is too light for the page's light text, so such a look is **refused**:

- **Upload:** HTTP 422 with a plain message that names the slot, for example `surface: text on a card reaches only 1.1:1 and needs 4.5:1. The page text is light, so choose a darker card colour.` Nothing is stored. The audit line holds the code `styles-unreadable`.
- **Serve:** if a stored report somehow carries such a look, it is dropped and the neutral look is shown; the log gets the code `styles-unreadable` and nothing else.
- **Check tool:** `tools/check-styles.mjs` prints `REFUSED` and exits 1.
- Rule of thumb: the card must be dark enough that the page's light text reaches 4.5:1 on it. Mid-grey cards usually fail.
- Not refused: a dim `accent` on the stage and a faint card edge are advisory (listed as LOW by the check tool); a dark text colour that nudging can lighten is simply adjusted.

## If an upload is refused

| Message | What to do |
|---|---|
| `"acent" is not a styles name` | fix the spelling; the names are listed in the message |
| `accent must be a colour like #1a2b3c` | use six hex digits |
| `surface: text on a card reaches only 1.1:1 ...` | the named colour cannot be read; choose a darker card (see "A look must be readable") |
| `headingFont must be one of: Oswald, Inter` | only the bundled fonts can be named |
| `The styles part and the data part do not carry the same hash` | rebuild the body with `make-envelope.mjs` |
| `A part name appears more than once in the request` | send each part once |

## Safety in short

- No CSS or text from the file is copied into the page as it was sent: the server writes every line from checked values (hex colours, bundled font names, one of four case words), and checks the finished CSS once more.
- The names and texts reach the page only as escaped text (the title) and as JSON data that the page reads and checks again.
- Checked twice with the same function: at upload and again at serve.
- A leaked ingest secret already allows uploading reports; it now also allows choosing a look for them, including the agency name that appears in the page title and footer (as plain text, never as markup). A possible later control is an optional allow-list of agency names the ingest accepts; it is not built.
- A leaked ingest secret already allows uploading reports; it now also allows choosing a look for them. It still cannot run script, load an address from outside or change the stage and map colours. Keep the secret private and rotate it if it leaks.
- The security headers, including the content security policy, are the same with and without a look (a test checks the exact value). The policy allows inline style and script today; the look needs only inline style and data fonts.

## Adding a font

Only the fonts bundled in the image can be named (`Oswald` and `Inter`), so a styles file can never pull a font from anywhere. To add one:

1. Check the font's licence allows self-hosting and embedding (the SIL Open Font License does); keep its notice file.
2. Make a Latin-subset `.woff2` (under 200 KB; the server refuses a larger file, one that is not woff2, or an empty one).
3. Put the file and its licence notice in `apps/server/fonts/`, add its source and sha256 to `SOURCES.txt`, and add the name and file names to `BUNDLED_FONTS` in `apps/viewer/brand/styles.mjs` (and to the two font lists in the contract spec, `packages/contract/src/contractValues.ts` and `apps/server/ingest/contract-check.mjs`, and `FONTS` in `apps/viewer/src/lib/brand.ts`).
4. Build a new image and run the tests; the font tests check size, the `wOF2` marker and that the name list matches.

## Later items

- An optional allow-list of agency names for the ingest (only those names accepted in a look), as a control against a leaked ingest secret choosing any name. Not built.
- The profile source in the plugin will later become the tagged client contract in the home vault.

- Showing a look in the Studio's own preview (today it shows on the client link only).
- More bundled fonts.
- Removing the build-time brand folder (it still works as a fallback; a report's look replaces it).
