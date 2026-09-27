# ADR-0060: One canvas, detail by degrees

**Status:** accepted 2026-09-27. The owner walked through a fresh install on 2026-09-27 and found it
hard to use. The lead proposed five changes on the owner's sign-off page,
https://claude.ai/artifact/VEBbxLMLyAjCxFyFu7B9cQ, and the owner answered each one there the same
day. Nothing below is built yet. Where this record and `docs/UI-SPEC.md` disagree, this record wins.

## What the walkthrough found

- Right-click showed the browser's own menu. UI-SPEC promises "right-click on anything", but no
  component handles it.
- The three icons in the folded rail do nothing: `shell/Strip.tsx` draws them with no action. Only
  the small › handle acts. It opens the catalogue, and dragging from it is the only way to add
  anything.
- There was no way to find a blank canvas or a wall. A wall is the palette's "Board" item, and the
  drawing is rack-first: the first thing placed makes a rack.
- Every design must sit in a Site, Building or Closet, and a design has no name of its own, so
  nothing can be drawn before a Site exists.
- The server's admin screen is called "Site", the word the home screen uses for the top folder, and
  it is hard to find. No screen and no server route lets an organisation invite people or change
  their roles. Creating an organisation shows the operator's form, the one-time code and the claim
  as separate steps.
- A "React Flow" link sits in the canvas's bottom-right corner: the drawing library's default
  attribution.

## Decisions

1. **Two places: Canvas and Inventory.** Racks is renamed Canvas, because "not everything here
   should be a rack". Inventory stays its own place: two tools over one design that work closely
   together. A whole network can be built in Inventory through menus and forms and then seen on the
   Canvas, and the other way round. A design opens on the Canvas, unless it was opened from a
   search result, which opens where that thing is.
2. **One canvas, detail by degrees.** There is no separate diagram view: "there should not be a
   difference between Diagram and Racks. It's just a matter of how much detail a user put in."
   - The canvas takes free-standing boxes and lines as well as racks, walls and ports.
   - A line between two boxes needs no ports; they are chosen later, when the box gets its model.
   - Walls sit beside the racks, with an Add wall button.

   This replaces "rack-first" in UI-SPEC's "The shape": the rack is the most detailed thing on the
   canvas, not the only one. ADR-0046's rule of no view tabs inside the drawing stands.
3. **Diagram styles.** Plain boxes are one style, and standard network icons are another. Which icon
   set, and whether the style belongs to the design or to the viewer, is open (below).
4. **The canvas explains itself.**
   - A labelled side panel replaces the rail's marks. It has a search box, then common devices
     (router, switch, firewall, server, access point, PC, patch panel, internet), then Rack and
     Wall, then catalogue models. Click to add, or drag. It is open by default and remembers being
     folded.
   - Right-click opens a menu on anything, the empty canvas included (add device here, add rack,
     add wall). Press and hold does the same on a touch screen.
   - An empty design says what to do next.
   - Controls show their name on hover.
   - Board is renamed Wall; it still covers a board on a floor or desk.

   This reverses two rules: the rail folded to unlabelled marks, and no hover labels.
5. **Rack sizes.** A rack's size is chosen when it is made and can be changed later: three common
   sizes first, then a custom size. Today every new rack is 42U, and the editor shows its height
   read-only.
6. **No Site needed to start.**
   - New design sits at the top of the home screen and inside each Site. With no Site yet, it makes
     one and opens the canvas.
   - Designs get their own names: "Untitled design" at first, renamed at any time. This reopens
     ADR-0054's "a design still has no name". Before names are built, the lead finds out why
     designs were left unnamed; if the reason is about security, it goes back to the owner.
   - Sites, Buildings and Closets stay, for folders and for per-building permissions.
7. **Organisation and Admin are tabs on the home screen:** Designs · Organisation · Admin. Each tab
   shows only to people allowed to use it. Every organisation and server function moves there from
   where it is today. The account menu keeps only what belongs to the person: "the profile icon
   should just be for user specific functions".
   - Organisation, for the organisation's stewards: people, invitations, roles, folders, the
     recovery key and signed-in devices.
   - Admin, for the operator: today's console, renamed from Site.
   - Invitations and roles need server routes, so they come after the tabs.
   - A one-form "Create an organisation for myself", for people who run their own server, is
     wanted. It needs a security review first, because it touches ADR-0055's two custodies.
8. **Cable groups (#54) pause** until this work is done. Branch `claude/wip` at 1915038 keeps the
   work, and the handoff is on #54.
9. **Questions for the owner go to the sign-off page.**
   - Each question is a card with a recommendation and the lead's pick already selected. The owner
     presses Approve, or Needs changes with a note.
   - The lead reads the answers back from the page.
   - A card links the render it asks about. Renders are temporary pages, not repository files.
10. **Opening a device.** Today a click shows "a tiny view on the left hand side … and that's it".
    - A click selects a device and shows its details.
    - Right-click → Open, or a double-click, goes into it. The device fills the screen, drawn large
      with its ports, in free space rather than a rack: "jot mode", in the owner's words.
    - Other equipment can be dropped into that space and cabled straight to the device's ports.
    - It is the same canvas zoomed onto one device, so anything added there is part of the design.
    - The top bar's path, or Esc, leads back out.

## Open, for the next cards

- **The missing side bar.** The first sketch left out a side bar. It is probably the trail strip on
  the right edge, and the editor that slides in beside it. The next render shows the whole screen.
- **The tiny view.** Which panel the owner saw on clicking a device. The details panel is 316 pixels
  wide at the right in the code, so the next render shows today's screen and asks.
- **Inside an opened device.**
  - Where the things dropped around a device appear on the full canvas: beside it, or waiting to be
    placed.
  - Whether a device's insides (virtual machines, firewall zones) are one more step in, as the
    approved Inside boards draw them.
- **Which three rack sizes.** Proposal: 42U, 24U and 12U, then Custom.
- **Icon sets.** Which standard network icons, under what licence, and whether the style is set per
  design or per viewer. The licence is checked from its source before any set is used.
- **Search.** Confirm that a search result opens where the thing lives: a device or rack on the
  Canvas, a row in Inventory.
- **The account menu.** Proposal: your account, signed-in devices, theme, sign out.
- **The React Flow link.** React Flow is under the MIT licence, which lets anyone use it, in a
  business too, without paying, as long as the licence notice travels with the code. Hiding the
  link is allowed. Its authors ask organisations that make money from it, and anyone who hides the
  link, to support them through React Flow Pro or GitHub Sponsors. That is a request, not a
  condition of the licence.
  - Sources: `LICENSE`, the README's "Commercial Usage" section and the `hideAttribution` note in
    `@xyflow/react` 12.11.6 as installed, read 2026-09-27. reactflow.dev could not be reached from
    the build container.
  - The owner's call: keep the link or hide it.
- **Licences of the browser's dependencies.** `deny.toml` holds the Rust dependencies to a list of
  permissive licences, but `scripts/gate-npm.sh` does not check licences. Proposal: add a licence
  check for npm too.
- **The order of work**, proposed again with these decisions in.
