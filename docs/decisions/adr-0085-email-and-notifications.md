# ADR-0085: Email and notifications over the SMTP setting

**Status:** proposed 2026-11-02. Choices are on the Sign-offs page, card `r85-email`, with the
recommended pick ticked. Nothing is built.

**Builds on:** ADR-0055 (the `smtp` console setting, sealed, and decision 7's reset by mail),
ADR-0065 decision 6 (device approval by mail), the r75 work plan item 8 (approved 2026-11-02).
**Waits on:** the Work tab (r74, r75 item 4) for the work notices; orders and jobs (ADR-0084) for
the order receipt.
**Keeps:** NIST SP 800-63B rev 4 §3.1.1.2, *"Email SHALL NOT be used for out-of-band
authentication"*, as ADR-0055 and ADR-0065 record it. A mail is a notice and a way to reach a page,
never a factor and never a way in by itself.

## Context

The console has an SMTP form (host, port, TLS mode, user, sealed password, from address) and a
test-send endpoint that answers 503, because no mail client ships (`admin.rs`, `placement.rs`,
STATE.md "Not built"). ADR-0055 and ADR-0065 already decided two mails that wait on this: the
password reset and the device approval notice.

The owner's r74 note asks for more: telling people when work is assigned, started, went
differently or done; a receipt when an order is placed; and a button in the receipt to ask for the
IPs sooner. On r75 the question of Gmail's interactive email format (AMP for Email) was left to be
looked up here rather than guessed.

## What Gmail's AMP for Email requires (read 2026-11-02)

All from Google's own pages, each marked *last updated 2026-09-03 UTC*:

- **Registration is per sender address, not per domain.** A sender sends a real production email
  with the AMP part to Google's review address and fills in a form; Google aims to answer within
  five business days and can revoke at any time. Testing tools and playgrounds are never
  allowlisted, and users may not author and send the mail directly.
  (developers.google.com/workspace/gmail/ampemail/register)
- **The sender's eTLD+1 must serve a public, non-parked website reachable worldwide without an IP
  filter.** (same page)
- **SPF, DKIM and DMARC must pass**, with the DKIM `d=` domain aligned to the `From` domain
  (relaxed alignment, RFC 7489 §3.1.1), and the mail must travel over TLS.
  (…/ampemail/security-requirements)
- **Every `amp-list` and `amp-form` endpoint is called through Google's proxy with cookies
  stripped**, must implement AMP's CORS with `AMP-Email-Allow-Sender`, and must not redirect.
  (same page)
- **Authentication is a token in the URL**, *"cryptographically secure and time- and
  scope-limited"*. Gmail treats the AMP part as usable for 30 days after receipt, so Google
  suggests 31-day tokens. (…/ampemail/authenticating-requests)
- **Clients:** amp.dev lists AOL Mail, FairEmail, Gmail, Mail.ru and Yahoo Mail
  (amp.dev/support/faq/email-support, read 2026-11-02; the page carries no date). Outlook and Apple
  Mail are not listed, so every AMP mail needs a plain HTML or text part that does the same job.

What that means for Fathom: Fathom is self-hosted, often on a network Google's proxy cannot reach,
and each deployment sends from its own address. Every operator would have to register their own
address with Google and expose a public endpoint that accepts 31-day bearer tokens from Google's
proxy. The button would still only work for the share of readers on Gmail, Yahoo, AOL or Mail.ru.

## Gmail's rules for every sender (read 2026-11-02)

From *Email sender guidelines* (support.google.com/mail/answer/81126): every sender needs SPF or
DKIM, valid forward and reverse DNS, TLS, a spam rate under 0.3%, RFC 5322 formatting with a valid
`Message-ID`, and no impersonated Gmail `From`. Senders of 5,000 or more a day also need SPF and
DKIM, DMARC, alignment, and one-click unsubscribe (RFC 8058) on marketing and subscribed mail.

SPF, DKIM, DMARC and reverse DNS belong to the operator's mail relay and domain, not to Fathom.
Fathom's part is a well-formed message, TLS to the relay, and the headers below.

## Decided (proposed; the card's picks)

1. **No AMP.** Every mail is `multipart/alternative` with a plain text part and a plain HTML part.
   A button is a link. Revisit only if a hosted Fathom with one registered sender ever exists.
   *(card question 1)*

2. **A link opens Fathom; it never does the thing.** Mail scanners fetch links on their own (RFC
   8058 §1: *"anti-spam software often fetches all resources in mail header fields automatically,
   without any action by the user"*), so a GET from a mail changes nothing. **Ask for the IPs
   sooner** opens the order in Fathom with the request ready; the person signs in as usual and
   presses it there. The link carries the order's id, not a credential. *(question 2)*

3. **What a mail may say: the least.** Mail leaves Fathom's encryption and sits on other people's
   servers. A mail says what happened, the work number and title, who did it and when, and the
   link. It never carries addresses, configs, device details, notes, comments' text or anything
   from the vault. A Steward may turn titles off for their organisation when titles are sensitive.
   *(question 3)*

4. **The mails, in order of building:**
   - **Security, always on:** password reset (ADR-0055 d7), device approval (ADR-0065 d6), a new
     sign-in from a new place, an AI key disabled (ADR-0072). These cannot be turned off; a person
     can only change where they go by changing their confirmed address.
   - **Work, each one a person's own switch:** at once by default for assigned to you or your
     team, went differently (a step didn't go to plan) and a comment that names you; in the daily
     digest by default for started, done and due tomorrow.
   - **Orders (after ADR-0084):** the receipt to the person who placed it, and *IPs added* as a
     short follow-up, since a sent mail cannot change. *(question 4: which work notices are on by
     default)*

5. **Who can be mailed: people with a Fathom account and a confirmed address.** An outside contact
   on an order (a customer with no account) is the orders design's question; this ADR only sets the
   rule that such a link could do one narrow thing and show nothing a receipt does not.
   *(question 5)*

6. **Each person chooses each mail, plus a daily digest.** Per kind: at once, in the daily digest,
   or off. Security mails are always at once. *(question 6)*

7. **Sending never slows a request.** A mail is written to a sealed outbox row in the same
   transaction as the event that causes it, and a worker sends it with retries (1, 5, 30 minutes,
   then 2 and 12 hours; then it is marked failed). Admin › Mail lists what was sent, queued and
   failed, with the relay's reply, never the body. The console's test send becomes real. A person
   who gets more than 30 work mails an hour is moved to the digest for the rest of the hour.

8. **Headers.** `Message-ID` under the from-address's domain; `Auto-Submitted: auto-generated`
   (RFC 3834 §5); for the work and order mails (not security), `List-Unsubscribe` with one HTTPS
   URL and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058 §3.1). RFC 8058 requires a
   DKIM signature covering both headers, which the operator's relay adds; `docs/OPERATING.md` says
   so. Mails about one piece of work share `References` so mail apps thread them. No tracking
   pixels, no images from the server, no open or click counting.

9. **The SMTP client: `lettre`, SMTP and rustls only.** `lettre` 0.11.23 (crates.io, updated
   2026-08-03) with default features off and only its SMTP, builder and tokio-rustls features. TLS
   uses the rustls and ring already in the tree, which means **widening C7's one exception** in
   `deps/decisions/ring.md` and `deny.toml` from "outbound HTTPS to outside vaults" to "and SMTP to
   the operator's relay". The new crates are counted from `cargo tree` when it is built and brought
   to the owner, like every other library. The other way is a small client of our own over
   `tokio-rustls`; it adds no crates but is a mail protocol written by hand. *(question 7)*

10. **TLS to the relay.** `starttls` and `implicit` verify the relay's certificate against the
    system roots. `none` stays allowed only to a loopback address, as the form already intends, and
    the console says so. A `starttls` relay that does not offer STARTTLS is a failure, never a
    fall back to plain.

## Consequences

- Reset by mail and device approval can be built as soon as decision 9 is answered; they need
  nothing from the Work tab.
- The ring exception grows by one use; a third use still fails the build.
- Gmail's 5,000-a-day rules will not bind most deployments, but the headers above meet them anyway.
- No email ever does anything without the person signing in, so a forwarded or leaked mail shows
  a title and a link and nothing more.

## Sources

- Google, *Register with Gmail* (AMP), developers.google.com/workspace/gmail/ampemail/register,
  last updated 2026-09-03, read 2026-11-02.
- Google, *Security requirements for AMP emails*, …/ampemail/security-requirements, last updated
  2026-09-03, read 2026-11-02.
- Google, *Authenticate requests*, …/ampemail/authenticating-requests, last updated 2026-09-03,
  read 2026-11-02.
- amp.dev, *Email support FAQ*, amp.dev/support/faq/email-support, undated, read 2026-11-02.
- Google, *Email sender guidelines*, support.google.com/mail/answer/81126, read 2026-11-02.
- RFC 8058, *Signaling One-Click Functionality for List Email Headers*, §1 and §3.1.
- RFC 3834, *Recommendations for Automatic Responses to Electronic Mail*, §5.
- NIST SP 800-63B rev 4 §3.1.1.2, as quoted in ADR-0055 (read 2026-09-21).
- crates.io API for `lettre`, read 2026-11-02.
