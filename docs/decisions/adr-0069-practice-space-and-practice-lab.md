# ADR-0069: A practice space for the operator, and a practice lab

**Status:** accepted 2026-10-25 (owner answered sign-off cards nu-firstrun, A "your own practice
space", and nu-why, A "a second practice sample", 25 October). Built in PR #189.

**Context.** A role-played first run by a home-labber (25 October) found two gaps. On a fresh
install the person who set the server up is an operator with no organisation, so Home showed
"Waiting for someone to add you" to the only person on the server, and the sample home lab could
not be opened at all. And the one sample network has nothing wrong with it, so Checks, the tool
that teaches by finding mistakes, has nothing to say on it.

ADR-0055 keeps two custodies apart: operators run the server, organisations own designs, and an
operator cannot grant themselves into an organisation. Any fix has to keep that.

## Decided

1. **A practice space is an ordinary organisation**, made by the same two steps as any other: the
   operator act creates a shell (`POST /admin/organisations/practice`), and the operator's own
   account redeems the claim with a fresh root key, which signs the genesis grant. No new authority
   path, no operator bypass.
2. **The root key is generated unextractable and dropped.** There is no recovery key to keep. A
   practice space is disposable by design; losing it loses nothing real. The words on screen say
   so ("Only you see it", and real work goes in an organisation people are invited to).
3. **The practice mark is sealed.** `organisation_shells.practice` is part of the shell's row seal
   and of the site-chain entry's metadata, in both only when true, so every seal and entry made
   before this record is unchanged. A shell flipped to practice in the database without a reseal
   does not redeem (test `a_shell_flipped_to_practice_without_a_reseal_does_not_redeem`).
4. **`organisations.practice` is a display label only**, copied from the shell at redemption.
   Nothing grants, hides or permits on it. It sorts the space into its own "Practice" list on Home.
5. **First run.** When the signed-in account has no organisation and is an operator, Home's centre
   offers "Open practice lab": one press makes the space (asking for the Admin code only if this
   sign-in has not given it) and opens the sample home lab in it. The rail says "None. That's
   fine: you look after the server, and organisations look after their own designs."
6. **The practice lab** (`corpus/samples/practice-lab.json`) is a second sample: the home lab with
   three planted mistakes, each one a Checks rule (`l2.vlan.access-mismatch`,
   `ip.address.network-or-broadcast`, `ip.address.different-subnet-on-link`). The sample lists its
   mistakes, so the canvas can say how many are planted and open Checks. A mistake the document
   model refuses outright (two cables on one port) cannot be planted and is not.

## Not decided

- Deleting or resetting a practice space. Today it stays.
- Practice spaces for people who are not operators. They join an organisation instead.
