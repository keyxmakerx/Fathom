# ADR-0075: The phone field view, scanning, and printed labels

**Status:** proposed 2026-10-26. The owner approved sign-off card 6 (r39-phone) as picked on 26
October, after noting on card 5 (available inventory with camera scanning): "we need a mobile view now
as well with the app. I don't think we are gonna go native app though". They then asked: "Could we
even connect it to QR codes for printing brother label printers?" Built as a draft PR.

**Builds on** ADR-0068 point 8 (labels and the scan page) and ADR-0060 (one canvas). **Keeps**
ADR-0072: AI ideas are only ideas; on a phone they are a tab, not a new kind of thing.

## Who and why

Someone in front of a rack or a cable with a phone: to see what a thing is and what it connects to,
to say the label is wrong or a cable is not where the design says, to take a photo, to tick off a
plan's steps, to report something down, and later to find a store bin. Drawing stays at a desk.

## Decisions

1. **A web page, not an app.** Under 760px wide (the width Inventory already folds to one column at)
   the same pages show with desk parts folded away and three tabs along the bottom: **Scan**, **Find**
   (the Inventory) and **Canvas** (pan and zoom, read-only: the session a picked save already uses).
   A fourth tab, **Ideas**, shows while an AI idea is waiting and opens the ideas full screen. A design
   opens on Find. Nothing new is written for the phone that a desk page already does.
2. **A label's code is a link:** `<this server>/scan#<design>/<id>`. The ids sit after `#`, so they
   never reach a server log, the way `/invite#` already works. The server answers `/scan` with the app.
   The app needs sign-in and Read on that design, then opens the item's ordinary Inventory page
   (`#inventory?k=…&o=…`, the same row keys the list uses). A design the person cannot open says so
   and shows nothing else. Only a link to this same server is followed; any other link is refused.
3. **Camera, three ways, no package.** The phone's own Camera app opens a label's link directly.
   Inside Fathom, **Scan** uses the browser's `BarcodeDetector` where it exists (Chrome on Android; off
   by default in Safari on iOS, caniuse read 2026-10-26) and always offers typing. Text that is not a
   label is looked up in Find, so a serial number works too. The camera stream stays on the phone:
   nothing it sees is sent anywhere.
4. **Add to Home Screen, nothing kept offline.** A web manifest and icons, no service worker. Nothing
   of a design is stored on the phone. CSP gains `manifest-src 'self'` (W3C CSP Level 3, read
   2026-10-26: without it the manifest falls back to `default-src`, which is `'none'` here).
5. **Labels, printed by the browser.** Inventory › tick rows › **Print labels**, for devices, racks,
   cables (two per cable, one for each end) and ports. Presets: Brother P-touch TZe tape 24, 18 and
   12 mm; Brother QL 62 mm continuous and 29 × 90 mm; A4 at thirty a sheet with cut lines. Each label is
   a page of its own size (`@page` named pages), so the printer's own driver does the rest; Brother
   publishes Linux LPR and CUPS drivers for its QL printers (support.brother.com, QL-820NWB FAQs, read
   2026-10-26). A code holds the link and nothing else about the network.
6. **For an AI app:** a design reading says how a label's link is built, and the connector's
   instructions say how to read one, so a person can paste a scanned link and ask about the item.

## Not yet

- **Room door labels** wait on rooms (sites and rooms are on hold).
- **Store bins** (available inventory): the scan link opens a store's page once that work lands; its
  ids are recognised by prefix (`store:`, `stock-item:`).
- **A public scan view** stays ADR-0068's later idea, behind a security review.

## Sources checked (rule 1)

- W3C Media Capture and Streams (`getUserMedia` is `[SecureContext]`) and WICG Shape Detection
  (`BarcodeDetector` is `[SecureContext]`), read from their GitHub sources 2026-10-26: the camera works
  only on HTTPS or `localhost`, which Fathom already needs for sign-in.
- W3C CSP Level 3, `manifest-src`, read 2026-10-26.
- mdn/browser-compat-data for `@page` `size` and the `page` property, read 2026-10-26.
