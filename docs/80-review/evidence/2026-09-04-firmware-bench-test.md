# The firmware login bench test — one SRX, one Arista, thirty minutes

> **Status: written 2026-09-04 for the owner to run on real hardware; not yet run.** The owner
> confirmed the same day that he has both boxes (`70` §20.3). This is the test `49` §16.1a(vi)
> and `WHAT-I-RECOMMEND-2026-09-04.md` §1 promised. **The Juniper half is precise**: every
> command is verified against Juniper's own published model (`Juniper/yang`, commit `96ad7bad`,
> read 2026-09-04, 25.2R1 and 25.4R1). **The Arista half is exploratory and says so**: Arista's
> documentation site is unreachable from the environment that wrote this, and the only vendor
> material found gives three spellings of the copy command and no key-login path at all.
>
> **What the test decides:** whether each box can fetch a file from the firmware server using
> its own SSH key, or only with a typed password. That single fact decides whether `49` §16.2's
> per-device-key design works on the owner's estate.

## 0. Before you start — safety, and what to set up once

- **Use a harmless file, not a firmware image.** Any small file on the server will do. The test
  is about *logging in*, not installing anything. **Do not run `install source`, `boot system`, or
  `request system software add`.** Nothing here changes what a box boots.
- **On the firmware server**, make one account, `fw-pull`, with **no password set** and a home
  directory containing the test file. Every box will try to log in as `fw-pull`. Because the
  account has no password, **a login can only succeed with a key** — which is what makes the test
  honest.
- Have a second terminal open on the server tailing its SSH log (`journalctl -u ssh -f` or
  `tail -f /var/log/auth.log`). Each attempt below shows up there, and the log line says whether
  the box offered a key.
- Write down each command exactly as you ran it and each result exactly as the box printed it.
  A screenshot is fine. *"It worked"* is not a result; the printed text is.

## 1. Juniper SRX — verified commands

Record first: `show version` (the model and the Junos release).

**Step 1 — make the box its own key.**

```
request security ssh key-pair-identity generate identity-name fw-pull
```

Verified: Juniper's model names this command exactly, with `identity-name` as its one required
argument (`junos-es-rpc-request@2025-01-01.yang`, rpc `generate-ssh-key-pair`, 25.2R1 line 4630).
If your release rejects the word `identity-name`, type the command up to `generate` and press `?`;
the model may present the argument positionally on your release. **Record the full output** — it
should tell you where the key went and, ideally, print the public half.

**Step 2 — find the public key and install it on the server.**

If step 1 did not print the public key, look for it: `file list /var/db/` and `file list
/var/home/<your-user>/.ssh/` are the usual places; `?` completion after `file show` will help.
Copy the public key line into the server's `/home/fw-pull/.ssh/authorized_keys`, as one line, with
these options in front of it so the key can do nothing but fetch a file:

```
restrict,from="<the SRX's management address>" ssh-...
```

**Step 3 — THE TEST: fetch with the key.**

```
request system download start sftp://fw-pull@<server>/<testfile> identity-file <what step 1 produced>
```

Verified: this command and its `identity-file` argument, described by Juniper as *"Identity file
for sftp pubic key authentication"* [sic], are in the model at 25.2R1 (line 2787) and 25.4R1
(line 2875). Three outcomes, and each is a result:

| the box prints | it means |
|---|---|
| a download id, and the file arrives | **Key login works.** §16.2's design holds on the SRX. Record the exact `identity-file` value that worked — that is what Fathom will generate. |
| `Password:` | The command ignored or could not use the identity. Record whether you gave it a file path or the identity NAME from step 1, and try the other form once. |
| an error naming the identity file | Format mismatch between what step 1 makes and what step 3 wants. **Copy the error verbatim** — it is the most useful line in this whole test. |

**Step 4 — the control: same command, no key.**

```
request system download start sftp://fw-pull@<server>/<testfile>
```

Expected: `Password:` or a refusal, because the account has no password. **If this succeeds, the
server is misconfigured** (it accepted something other than the key) and step 3's result cannot
be trusted until that is fixed.

**Step 5 — confirm the path Fathom must never use, without using it.**

Type `request system download start sftp://x@y/z login ?` and record what the box offers. The
model has a `login` argument taking `username:password`. **Do not run it against a real server
with a real password.** This step only confirms the argument exists on your release, so the
runbook Fathom generates can be tested for never emitting it.

## 2. Arista EOS — exploratory, and honest about it

Record first: `show version`.

**Step 1 — does the box have any client-key setting at all?**

```
show running-config section management ssh
configure
management ssh
?
```

Record every keyword the `?` offers. You are looking for anything like `client`, `identity`,
`key`, or `authentication` that applies to the switch *as a client* connecting outward. **The one
thing found in Arista's own material is `hostkey client strict-checking`** (host-key checking on
the far end, from Arista's AVD configuration model) — which is about verifying the *server*, not
about presenting a key. If nothing else is offered, that is a result: record it.

**Step 2 — the fetch, three ways.** Arista's own published files spell it three different ways,
and nobody has proved which your release accepts, so try each once and record what each prints.
If your management interface is in a VRF (commonly `mgmt` or `MGMT`), the second form is the one
real automation uses, with the VRF between source and destination.

```
copy scp:fw-pull@<server>/<testfile> flash:
copy scp://fw-pull@<server>/<testfile> vrf <mgmt-vrf> flash:
scp fw-pull@<server>:/<testfile> flash:
```

Then the same three with `sftp` in place of `scp`. Whether EOS accepts `sftp:` at all is
unestablished from vendor material; a rejection is a result.

**What each result means:**

| the box prints | it means |
|---|---|
| `Password:` on every form | **No key login on this release.** This is what every real-world example found so far shows. It means `fw-pull` on an Arista estate would be a shared password — the thing §16.2 rejected — and the Arista row stays *cannot help* until Arista documents otherwise. |
| a copy succeeds with no password prompt | **The box presented a key from somewhere.** Find out where: step 1's `?` output, or `show management ssh`. Record the exact form that worked. This would be new information not in any Arista material found. |
| a syntax error on a form | Record it and move to the next form. The three spellings exist because Arista's own files disagree; your release's error tells us which it is. |

**Do not** run `install source` or `boot system`. The test ends when you know how the box logs in.

## 3. What to send back

Two `show version` outputs, every command you ran with its printed result, and the server's SSH
log lines for each attempt. That is enough to write each platform's row in `49` §16.1 as a fact
with a date, and to decide whether Fathom generates a key-based runbook for the SRX and what it
says on the Arista row.

## Sources consulted

| source | what it establishes | read |
|---|---|---|
| `Juniper/yang` `96ad7bad`, `25.2/25.2R1/native/conf-and-rpcs/junos-es/rpc-with-extensions/models/junos-es-rpc-request@2025-01-01.yang` | `junos:command "request system download start"` and `junos:command "request security ssh key-pair-identity generate"` — the CLI spellings | 2026-09-04 |
| same repo, `.../junos-es/rpc/models/junos-es-rpc-request@2025-01-01.yang` lines 2787 and 4630; 25.4R1 line 2875 | the `identity-file`, `login`, `passphrase` and `identity-name` arguments and their descriptions | 2026-09-04 |
| same repo, `.../junos-es/rpc/models/junos-es-rpc-file-mgd@2025-01-01.yang` | `file copy` has exactly source, destination, source-address, routing-instance — no key argument, which is why this test uses `request system download start` instead | 2026-09-04 |
| `49` §16.1a (iii), (iv) and the traps recorded there | the three Arista spellings, the VRF token position, and that no Arista-authored material shows a client key | 2026-09-04 |

## Disagreements

1. `49` §16.1 tells Fathom to generate Juniper's two-step flow via `file copy`. This test uses
   `request system download start` because that is the command with a key slot. If step 3
   succeeds, §16.1's Juniper row should say so and the runbook design should follow the command
   that can authenticate with a key, not the one the vendor page happened to describe.
