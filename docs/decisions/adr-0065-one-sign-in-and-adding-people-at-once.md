# ADR-0065: One sign-in, and adding people at once

**Status:** accepted 2026-10-12 on the owner's instruction (below). The choices that could go
either way are on the sign-off page with the recommended pick built; the owner can override them
there. **Amends** ADR-0057 decision 2 (the 15-minute grace before Admin asks for a fresh code) and
the steward-invitation design behind migration `0037` (every invitation waits for a key-check
code and a confirm). Everything else in ADR-0055, ADR-0056 and ADR-0057 stands.

## The ask, in the owner's words (2026-10-12)

*"There shouldn't be 3 logins for me, instead there isn't even a clickable login, i login with my
username and password, you have 2 factor enabled for me which is good … However if i want to add
another user, then i just can. UNLESS i have SMTP setup, then it will send a message to my email
asking for me to verify securely, re-checking via my 2 factor, that i can allow this device to
have access to the admin console. I can also set a duration. Make sure the admin console can't
have cache vulnerabilities. Also, make sure admin panel opens to admin, and it's easy to
naviate. i got lost when i tried to accept her invite."*

## What was wrong, read off main on 2026-10-12

1. The sign-in card listed every key this browser held under "Saved on this browser" as a
   button: the account's key, an operator key, and the key of anyone whose invitation link was
   opened in it. Those were the "3 logins".
2. Admin asked for a fresh verification code whenever the sign-in's code was more than 15 minutes
   old (ADR-0057 decision 2), and the operator plane idles out after 15 minutes, so in practice
   every visit to Admin was a second sign-in.
3. Adding a person was three steps for the steward and one for the person: make a link, wait for
   them to join, compare a key-check code they read out, then sign a confirm from the browser that
   holds the steward's key. With more than one browser that last step failed (fixed by #162).
4. An invitation link opened by someone already signed in was read and dropped, leaving them on
   Home with no word about it.
5. Only some routes said `Cache-Control: no-store`; the rest left caching to the browser and any
   proxy.

## Decisions

1. **One sign-in.** The card is address, password, then the verification code when the account
   has an authenticator. No list of saved identities.
2. **Admin opens with that sign-in.** The grace before Admin asks for a fresh code is the account
   session's whole life (12 hours), not 15 minutes. ADR-0057 decision 6 stands: the grace lives
   only in the tab's memory, so a reload or a copied browser profile still needs a code once.
   The console has a row of sections (Accounts, Organisations, Operators, Settings) and shows one
   at a time.
3. **Adding a person makes them a member at once.** For Read and Draw, pressing Add makes the
   invitation and, in the same press, the steward's browser signs the grant. The person has no
   key yet, so the grant names the account and carries an all-zero subject key fingerprint
   (`grants::NO_SUBJECT_KEY`), inside the signed bytes. The invitation moves to a new state,
   `added` (migration `0039`); the link then enrols the person's first key and moves it to
   `confirmed`, with no confirm and no code.
   - **What the verifier does with it.** `verify_grant_row` skips the subject key lookup for that
     fingerprint and checks everything else as before: the row seal, the granter's key binding
     and the granter's signature. Authorisation has always matched the account, never the key,
     so nothing downstream read the binding.
   - **Where it is refused.** `sign_grant_at` writes a no-key grant only for Read or Draw, only
     for an account that is already a member in the same transaction, and only while that
     account has never held a key. `verify_grant_row` refuses a no-key Steward grant outright.
     The client refuses a proposal that puts a key on a person being added, or adds a steward.
   - **Stewards are still invited and confirmed**, one at a time, with the seconding or the
     one-day sole-steward wait. Appointing a steward is the act that hands out the power to add,
     and it keeps its ceremony.
   - **If signing fails** (this browser holds no key for the steward, the head moved), the
     invitation stands as an ordinary one and the screen says why. Nothing is lost.
4. **An invitation link opened while signed in** gets its own screen: whose link it is, that it is
   for the invited person, and two buttons, Back to Fathom or Sign out and use it.
5. **No caching of anything but the hashed bundle.** Every response carries
   `Cache-Control: no-store` unless it is a fingerprinted file under `/assets/`; sign-out answers
   `Clear-Site-Data: "cache"`. The content security policy does not move.
6. **Device approval by mail is the next step, not this one.** Once SMTP is set, a browser asking
   for Admin that has not been approved gets a mail to the operator's own address; the link opens
   a page that asks for the authenticator code and how long to trust that browser, and only then
   lets it in. The mail is a notice and a way to reach the approval page, never a factor on its
   own: NIST SP 800-63B rev 4 §3.1.1.2, *"Email SHALL NOT be used for out-of-band
   authentication"*, as recorded in ADR-0055 (read 2026-09-21). Fathom has no mail sender yet
   (ADR-0055 stage 5), so this is built with it, in its own change.

## What it gives up, named

- **The key-check code for Read and Draw.** It caught one thing: someone other than the invited
  person opening the link first. That is now caught the way every product with invitation links
  catches it: the link works once, expires after 72 hours, and People shows "Added, has not
  signed in yet" until it is used, so a steward who hears "my link didn't work" sees it was used
  and removes that access. The code never protected against the server, which already holds every
  key (ADR-0040).
- **A grant that names no key.** The audit trail for an added person shows the account and not
  the key it later enrolled; the key is on the invitation row (`enrolled_key_fpr`) and in the
  site chain's redemption entry.
- **Admin re-asking within the hour.** A tab left signed in can open Admin until the session ends
  (12 hours absolute, 1 hour idle on the account plane), as it can open everything else. The
  device approval in decision 6 is where the extra wall goes back, by browser rather than by
  clock.
