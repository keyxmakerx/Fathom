# ADR-0078: Termix beside Fathom — open a device's terminal, Fathom never connects

**Status:** proposed 2026-10-27. Built on the recommended picks on sign-off card r43-termix
so the owner can override them on the page; nothing merges until the owner says so.

**Keeps** invariant 2 ("the application never touches a network device"), invariant 1 (no egress
the operator did not configure), rule 4 and ADR-0042 (no credential leaves Fathom without being
shown and chosen), and ADR-0071 part four's scope for the server's one outbound HTTPS client
("to an outside vault and nowhere else").

## What the owner asked for

> what about integration with a termix instance too?

Termix (github.com/Termix-SSH/Termix) is a self-hosted, browser-based SSH manager. The most
useful reading: from a device in Fathom, get to its terminal in Termix without typing the address
again.

## What Termix offers

Read from Termix's source at commit 73c15f7 (22 October 2026), on 27 October 2026. Not from memory
(CLAUDE.md rule 1).

| Fact | Where |
|---|---|
| An API key is `tmx_` plus 64 hex characters, made by a Termix admin for one Termix user, sent as `Authorization: Bearer`. It acts as that user, cannot impersonate another, and can expire. | `src/backend/database/routes/user-api-key-routes.ts`; `src/backend/utils/auth-manager.ts`, `handleApiKeyAuth` |
| `GET /host/db/host` lists the hosts the user can see, with `id`, `name`, `ip`, `port`. `POST /host/db/host` adds one and needs only `ip` and a valid `port`; no user name and no secret are required. | `src/backend/database/routes/host.ts` |
| `/?view=terminal&hostId=<id>` opens one host's terminal full screen. Signed out, Termix signs the browser in and comes back to the link. | `src/main.tsx` (`FullscreenApp`), `src/ui/lib/view-link-resume.ts`; the `terminal` tab is the bundled ssh-terminal plugin's (`Termix-SSH/Plugin-SSH-Terminal`, `src/frontend/index.tsx`) |
| Termix's API answers any origin, with `Authorization` allowed, unless its operator sets `CORS_ALLOWED_ORIGINS`; then only the listed origins. | `src/backend/utils/cors-config.ts` |
| Bulk import (`/plugin-api/import-export/bulk-import`, 100 hosts a call) is a plugin's, not core's. | `Termix-SSH/Plugin-Import-Export`, `src/backend/routes.ts` |

## Decided (the recommended picks; the owner can override each on the page)

1. **The browser talks to Termix; the server does not** (card r43-termix, question 1, A). The server
   would need its outbound HTTPS client for this, and that client and `ring` under it are allowed
   for outside vaults only. The browser can reach Termix directly, because Termix allows any
   origin by default. So the server's whole part is:
   - `FATHOM_TERMIX_URL`, one origin the operator names (`https://`, or `http://` to a loopback
     host). It is refused at startup unless it is a bare origin of letters, digits, dots, hyphens
     and a port (`src/termix.rs`), because it is written into a header.
   - That origin added to `connect-src` in the content security policy (`client.rs`). Unset, the
     policy is byte-for-byte what it was.
   - `GET /integrations/termix`, behind a session, telling the browser the address.
2. **No credential goes to Termix** (card r43-termix, question 2, A). A host Fathom adds carries a name
   (the device's host name), the management address, port 22, the folder `Fathom` and the tag
   `fathom`. No user name, no password, no key. The person picks one of Termix's own credentials
   in Termix. Vault logins stay in the vault.
3. **The Termix API key stays in the tab** (card r43-termix, question 3, A). The person pastes their own
   key the first time they open a device; it is kept in `sessionStorage`, sent only to the Termix
   origin, with `credentials: 'omit'` and redirects refused, and forgotten when the tab closes, on
   "Forget key", or when Termix refuses it. Fathom's server never sees it.
4. **Where it shows:** the device panel's Management fold, under the management address, as
   "Open in Termix". It finds the Termix host at that address (port 22 first), opens its terminal
   in a new tab, and when there is none offers "Add it to Termix" and then opens it.

## Why invariant 2 still holds

Fathom opens no connection to a device, from the server or the browser. The browser asks Termix
which host has an address and, when asked, tells Termix to remember one; Termix connects, in a tab
the person opened, as the Termix user the key belongs to. `management_address` stays "inventory
only" in the schema: Fathom does not use it to reach anything, it hands it to a tool the operator
chose.

## What this does not protect against

- A script running in Fathom's page could read the key from `sessionStorage` and use it against
  Termix. That is the same exposure every other secret in the page has (the vault's unlocked keys
  included), and the content security policy is what keeps foreign script out.
- An operator who names the wrong Termix sends people's Termix keys there. The address is the
  operator's to get right, like `FATHOM_AI_PUBLIC_URL`.

## Not built, and why

- **Sending a whole design to Termix at once.** One device at a time first; a bulk send is the
  obvious next step once the owner has used it (card r43-termix notes it).
- **Server-side sync with an organisation-wide key** (option B on the shape card). It needs the
  owner to widen the outbound HTTPS exception, and a key that acts for everyone.
- **Opening Termix inside Fathom.** `frame-src` stays closed; a new tab is enough.
