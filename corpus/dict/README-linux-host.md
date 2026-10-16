# README-linux-host.md — how a Linux host's `ip` output is read

**Status:** Rewritten 2026-10-16, when `crates/fathom-ingest/src/iproute.rs` gave the core the front
end this file's 2026-09-19 version said was missing. The dictionary is
`corpus/dict/linux-host/interfaces.yaml`; the platform row is `linux-host` (vendor `linux`) in
`schema/platforms.yaml`.

## What is read

What a Linux host prints about its own interfaces, pasted as text:

- `ip addr` / `ip -4 -6 addr show`, and `ip -d link show`, in their full form: a numbered header line
  per interface and indented attribute lines under it.
- The same commands with `-o`, which print each record on one line with `\` between its parts.
- A shell prompt above the output (`root@fw1:~# ip addr`, `[ops@nas-01 ~]$ ip a`).

The output shapes were checked against the iproute2 manual pages `ip-address(8)` and `ip-link(8)`
(man7.org, first read 2026-09-19 for this file's earlier version and corroborated then by
baturin.org/docs/iproute2/), and the test captures in `crates/fathom-ingest/tests/linux_host.rs`
follow them.

## Why it needed a front end

None of these lines is `set`-form, so the set-form shaper refuses every one of them at its verb check
before any dictionary is consulted. That finding still holds, and `the_set_form_shaper_reads_no_line_of_it`
in the test file keeps it true. The fix is the one `csv.rs` and `routeros.rs` use: an attribute's
meaning is `(interface name, attribute word, value)`, all real bytes of the paste, so `iproute.rs`
synthesises one statement per attribute and the dictionary, gate, binder and ledger run unchanged.

```
[bond0.10]                        the record (the `@bond0` half is what it rides on, not its name)
[bond0.10, UP]                    one per flag in <…>
[bond0.10, mtu, 1500]             one per header pair
[bond0.10, vlan, id, 10]          one per pair on a `vlan` line
[bond0.10, inet, 10.10.10.1/24]   the first two words of an address line
[@, fw1]                          the host in a shell prompt
```

## What binds

| Paste | Binds |
|---|---|
| a record header | an `Interface` by name |
| `UP` in the flags | `admin_up: true` |
| `vlan … id N` | a `Vlan` with that id, named after the interface |
| `inet` / `inet6` | an `Address` under the interface |
| `user@host…$` / `#` | the device's `hostname` |

`UP` is `IFF_UP`, which the kernel's operstates document defines as "Interface is admin up"
(docs.kernel.org/networking/operstates.html, read 2026-10-16); `LOWER_UP` is carrier and is not read
as admin state. A header without `UP` is not read as admin down.

A prompt's host must open with a letter: `admin@10.0.0.1` is where someone connected to, not what the
box is called.

### Units

Linux puts an address on the interface itself, with no unit number. `schema/schema.yaml` owns
`Address` by `LogicalUnit`, so `inet`/`inet6` bind a keyless unit with index 0
(`const_enum: "u32.0"`), the same stated constant `README-routeros.md` uses.

## Secrets

`ip addr` and `ip link` print no credentials of their own. What arrives with them is other output
pasted in the same box, and two rules cover it:

- **Only known attribute words are shaped.** An indented line becomes a statement only when its first
  word is `inet`, `inet6`, `altname`, `vlan` or `link/…`. Anything else under a record yields no
  statement. This matters because `ip xfrm state` prints an IPsec SA's keys as `0x`-prefixed hex
  (`auth-trunc hmac(sha256) 0x6f7a…4314 128`, `enc cbc(aes) 0x77bb…522e`, from a strongSwan user's
  output, lists.strongswan.org users list, 2017-08, message 011358, read 2026-10-16), and its
  indented lines would otherwise be read as attributes of whatever interface was printed above them.
- **Every line is swept.** Each line, shaped or not, goes to the gate's safety-net sweep before
  anything is stored. The prompt's command is swept too (`sshpass -p '…'` takes a password as an
  argument).

`ipsec_keys_pasted_under_a_record_are_destroyed` and `a_secret_on_the_prompt_line_is_destroyed` in the
test file, and `ip_output_from_a_linux_host_is_detected_and_no_key_survives` in
`crates/fathom-wasm/tests/platforms.rs`, prove both at the keys' real 256-bit length. A WireGuard
private key (44 base64 characters, 32 bytes; sources in the test file's header) pasted alongside is
destroyed as before.

## Not bound yet

They are residue, not lost:

- The MTU. The schema's `Interface.mtu` is a structured `Mtu` with a layer and `dict.rs` has no scalar
  for it.
- `link/ether` MACs (the schema has `mac` on `PhysicalPort`, not `Interface`).
- `master br0` / bond membership, `altname`.
- `ip route` lines and the `bridge vlan show` table, which are not records. They are refused line by
  line (`NotVerbInitial`) and swept.
- `ip -br` brief output, which has no record header to sniff.
