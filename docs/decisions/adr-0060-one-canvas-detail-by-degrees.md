# ADR-0060: One canvas, detail by degrees

**Status:** accepted 2026-09-28. The owner walked through a fresh install on 2026-09-27 and found it
hard to use. The lead put proposals on the owner's sign-off page,
https://claude.ai/artifact/VEBbxLMLyAjCxFyFu7B9cQ, in two rounds. The owner answered round 1 on
2026-09-27 and round 2, with renders, on 2026-09-28. Nothing below is built yet. Where this record
and `docs/UI-SPEC.md` disagree, this record wins.

## What the walkthrough found

- Right-click showed the browser's own menu. UI-SPEC promises "right-click on anything", but no
  component handles it.
- The three icons in the folded rail do nothing: `shell/Strip.tsx` draws them with no action. The
  owner asked about them again in round 2. Only the small › handle acts. It opens the catalogue, and
  dragging from it is the only way to add anything.
- There was no way to find a blank canvas or a wall. A wall is the palette's "Board" item, and the
  drawing is rack-first: the first thing placed makes a rack.
- Every design must sit in a Site, Building or Closet, and a design has no name of its own, so
  nothing can be drawn before a Site exists.
- A device placed on a wall, board or floor asks for its position in millimetres. The owner called
  this "just an unreasonable ask".
- The server's admin screen is called "Site", the word the home screen uses for the top folder, and
  it is hard to find. No screen and no server route lets an organisation invite people or change
  their roles. Creating an organisation shows the operator's form, the one-time code and the claim
  as separate steps.
- A "React Flow" link sits in the canvas's bottom-right corner: the drawing library's default
  attribution.

## Decisions

1. **Two places: Canvas and Inventory.**
   - Racks is renamed Canvas, because "not everything here should be a rack".
   - Inventory stays its own place: two tools over one design that work closely together. A whole
     network can be built in Inventory through menus and forms and then seen on the Canvas, and the
     other way round.
   - A design opens on the Canvas. A search result opens where the thing lives: a device, rack or
     wall on the Canvas; a VLAN, an address or a list row in Inventory.
2. **One canvas, detail by degrees.** There is no separate diagram view: "there should not be a
   difference between Diagram and Racks. It's just a matter of how much detail a user put in."
   - The canvas takes free-standing boxes and lines as well as racks, walls and ports.
   - A line between two boxes needs no ports; they are chosen later, when the box gets its model.
   - A free box goes into a rack by dragging it onto the rack, or through right-click → Put in a
     rack. Its lines come with it.
   - Walls sit beside the racks, with an Add wall button.

   This replaces "rack-first" in UI-SPEC's "The shape": the rack is the most detailed thing on the
   canvas, not the only one. ADR-0046's rule of no view tabs inside the drawing stands.
3. **Diagram styles.**
   - There are three styles: plain boxes, network icons, and faceplates with their ports. A style
     changes how things are drawn, never what is in the design.
   - Each person picks their own style. A design sets the starting style, and Boxes is the default.
   - Fathom draws its own icons, in the standard shapes network people know. So no outside icon
     set's licence applies.
4. **The canvas explains itself.**
   - A labelled side panel replaces the rail's three marks. It has a search box, then common
     devices (router, switch, firewall, server, access point, PC, printer, patch panel, internet),
     then Rack and Wall, then catalogue models. Click to add, or drag. It is open by default and
     remembers being folded.
   - Right-click opens a menu on anything, the empty canvas included (add device here, add rack,
     add wall). Press and hold does the same on a touch screen.
   - An empty design says what to do next.
   - Controls show their name on hover.
   - ~~Board is renamed Wall; it still covers a board on a floor or desk.~~ *Reversed by the owner
     on 2026-10-02 (sign-off page, round 3):* it stays **Backboard**, with a one-line hint saying
     what it is for. Wall is already a separate thing on the canvas, so the rename would have given
     two things one name. The hint is not built yet.

   This reverses two rules: the rail folded to unlabelled marks, and no hover labels.
5. **Rack sizes.**
   - Adding a rack offers 42U, 24U and 12U first, then Custom.
   - A rack's height can be changed later in its details panel. It can't shrink below the devices in
     it, and Fathom names the device in the way.
   - Height comes now; width and depth come later.
6. **No Site needed to start.**
   - New design sits at the top of the home screen and inside each Site. With no Site yet, it makes
     one and opens the canvas.
   - Designs get their own names: "Untitled design" at first, renamed at any time. This reopens
     ADR-0054's "a design still has no name". Before names are built, the lead finds out why
     designs were left unnamed; if the reason is about security, it goes back to the owner.
   - Sites, Buildings and Closets stay, for folders and for per-building permissions.
7. **Organisation and Admin are tabs on the home screen:** Designs · Organisation · Admin.
   - Each tab shows only to people allowed to use it. Every organisation and server function moves
     there from where it is today.
   - Organisation, for the organisation's stewards: people, invitations, roles, folders, the
     recovery key and signed-in devices.
   - Admin, for the operator: today's console, renamed from Site.
   - The account menu, opened from the person's initials, holds only their own things: their
     account, signed-in devices, theme and sign out.
   - Invitations and roles need server routes, so they come after the tabs.
   - A one-form "Create an organisation for myself", for people who run their own server, is
     wanted. It needs a security review first, because it touches ADR-0055's two custodies.
8. **Cable groups (#54) pause** until this work is done. Branch `claude/wip` at 1915038 keeps the
   work, and the handoff is on #54.
9. **Questions for the owner go to the sign-off page.**
   - Each question is a card with a recommendation and the lead's pick already selected. The owner
     presses Approve, or Needs changes with a note.
   - The lead reads the answers back from the page.
   - A card links or shows the render it asks about, with slides when there are options to compare.
     Renders are temporary pages, not repository files.
10. **Opening a device.** Today a click shows "a tiny view on the left hand side … and that's it".
    - A click selects a device and shows its details.
    - Right-click → Open, or a double-click, goes into it. The device fills the canvas, drawn large
      with its ports, in free space rather than a rack: "jot mode", in the owner's words. The bar
      and side panels stay: "not actually full screen, but like full canvas screen".
    - Other equipment can be dropped into that space and cabled straight to the device's ports.
      Back on the full canvas, it sits beside the device as free boxes.
    - A device's insides (virtual machines, firewall zones) are one more level in, through an
      Inside button. The approved Inside boards draw them.
    - It is the same canvas zoomed onto one device, so anything added there is part of the design.
    - The top bar's path, or Esc, leads back out.
11. **Placing on a wall, board or floor is by dragging.** The editor stops asking for a position in
    millimetres.
12. **Credits and licences.**
    - The React Flow link is hidden. An About page credits React Flow and every other library, each
      with its licence.
    - A licence check for the browser's dependencies joins the gates. `deny.toml` already does this
      for the Rust dependencies.
    - React Flow is under the MIT licence. That lets anyone use it, in a business too, without
      paying, as long as the licence notice travels with the code. Hiding the link is allowed. Its
      authors ask organisations that make money from it, and anyone who hides the link, to support
      them through React Flow Pro or GitHub Sponsors. That is a request, not a condition of the
      licence.
    - Sources: `LICENSE`, the README's "Commercial Usage" section and the `hideAttribution` note in
      `@xyflow/react` 12.11.6 as installed, read 2026-09-27. reactflow.dev could not be reached
      from the build container.
13. **The order of work**, one small PR at a time:
    1. the side panel, click to add, the empty-design message, names on hover, and the renames
       (Racks to Canvas, Board to Wall);
    2. right-click menus;
    3. New design without a Site, and design names;
    4. the Organisation and Admin tabs, and the personal account menu;
    5. the credits page and the licence check;
    6. rack sizes, and placing by dragging;
    7. free boxes and lines on the canvas, beside racks and walls;
    8. opening a device;
    9. diagram styles;
    10. invitations and roles, then the one-form organisation setup after its security review.

    Cable groups (#54) picks up again after that.

## Round 3, answered 2026-10-02

The owner answered every card on the sign-off page's third round:

- **The order of the next work:** fix main's red CI (done, PR #84); one docs-only cleanup; the
  right-click menu's silent "no room" cases; step 3b, design names; step 7, free boxes and lines; a
  walkthrough by the owner on a fresh install; then steps 8 to 10, cable groups, and the rest of
  print and tags. The owner gives a go before each item from step 3b on.
- **Issues for later:** those that wait until this ADR is done get a `later` label and stay open.
- **The top bar keeps only what it has.** Organisation and Admin stay tabs on Home (decision 7).
- **Admins get an amber "Admin" pill next to their initials.** It shows only to people who may
  use the admin console, and only where the console answers (`FATHOM_ADMIN_HOSTS`). A small item,
  after the right-click fix.
- **Backboard keeps its name**, with a one-line hint (decision 4, amended above).
- **Every question on the sign-off page shows two mockups** of what is proposed, and the page opens
  on a view holding only what still waits on the owner.

## Step 3b, built 2026-10-02

Why designs had no name: a plaintext name would be a second copy in rows and logs (migration 0007).
So the name is sealed under the organisation content key, never in the clear, and a rename writes no
chain entry. Both go to the owner to confirm.

## Open

Nothing from rounds 1 and 2. The owner never said which panel was the "tiny view". The round 2 note
pointed at the rail's three marks, and decisions 4 and 10 replace every candidate. New questions go
to the sign-off page.
