# The mail closure — recorded 2026-11-14

What `lettre` 0.11.23 brings with it (`lettre.md`), as `scripts/closure-report.sh` printed it on
2026-11-14 after adding lettre with the features that record names. `lettre` itself has its own
record, as every direct dependency must.

**The owner approved these** on Sign-offs card r141-mail-built, 2026-11-14: B, "Switch to lettre",
which named the new libraries and that each needs approval under the dependency rule. The card
said 34; without lettre's message builder it is 31 below.

## What a reviewer should look at

- **Most of it is ICU4X**, Unicode's own Rust tables, through `url` → `idna` → `idna_adapter`.
  Unicode-3.0 licence, allowed in `deny.toml`. Two of them, `icu_normalizer_data` and
  `icu_properties_data`, have a `build.rs` (they select baked data), and four are proc macros
  (build-time only): `displaydoc`, `yoke-derive`, `zerofrom-derive` and `zerovec-derive`, with
  `synstructure`, the helper the derives build on.
- **`utf8_iter` 1.1.0 now depends on `utf_types` 1.0.0**, both by Henri Sivonen
  (`github.com/hsivonen`, the same author, read in each crate's manifest 2026-11-14).
  `scripts/lockfile-lookalikes.sh` passed.
- **`base64` 0.23.1** sits beside the 0.22.1 already under `postgres-protocol`; `deny.toml` names
  the older one.
- **The caps.** The closure is now 203 packages against ADR-0032 C2's 160, and two more crates
  carry a `build.rs` against C4's 12. Said here rather than smoothed over; no script enforces
  either cap today (`ring.md` records the same for the outside-vault crates).
- Every version is older than the seven-day cooldown (`scripts/crate-cooldown.sh`, 2026-11-14:
  youngest 16 days).

## The closure

<!-- gate-zero:closure approved-by="the owner" date="2026-11-14" -->

| crate | version | licence | direct | build.rs | proc-macro | published | repository |
|---|---|---|---|---|---|---|---|
| `base64` | `0.23.1` | MIT OR Apache-2.0 | transitive | no | no | Tue, 04 Aug 2026 12:34:35 GMT | https://github.com/marshallpierce/rust-base64 |
| `displaydoc` | `0.2.7` | MIT OR Apache-2.0 | transitive | no | yes | Tue, 28 Jul 2026 13:58:22 GMT | https://github.com/yaahc/displaydoc |
| `email_address` | `0.2.9` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:23:36 GMT | https://github.com/johnstonskj/rust-email_address.git |
| `form_urlencoded` | `1.2.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:12:29 GMT | https://github.com/servo/rust-url |
| `futures-io` | `0.3.34` | MIT OR Apache-2.0 | transitive | no | no | Tue, 11 Aug 2026 12:13:05 GMT | https://github.com/rust-lang/futures-rs |
| `icu_collections` | `2.4.0` | Unicode-3.0 | transitive | no | no | Thu, 22 Oct 2026 08:56:11 GMT | https://github.com/unicode-org/icu4x |
| `icu_locale_core` | `2.4.0` | Unicode-3.0 | transitive | no | no | Thu, 22 Oct 2026 08:51:55 GMT | https://github.com/unicode-org/icu4x |
| `icu_normalizer` | `2.4.0` | Unicode-3.0 | transitive | no | no | Thu, 22 Oct 2026 08:56:46 GMT | https://github.com/unicode-org/icu4x |
| `icu_normalizer_data` | `2.4.0` | Unicode-3.0 | transitive | yes | no | Thu, 22 Oct 2026 08:56:38 GMT | https://github.com/unicode-org/icu4x |
| `icu_properties` | `2.4.0` | Unicode-3.0 | transitive | no | no | Thu, 22 Oct 2026 08:56:23 GMT | https://github.com/unicode-org/icu4x |
| `icu_properties_data` | `2.4.0` | Unicode-3.0 | transitive | yes | no | Thu, 22 Oct 2026 08:56:16 GMT | https://github.com/unicode-org/icu4x |
| `icu_provider` | `2.4.0` | Unicode-3.0 | transitive | no | no | Thu, 22 Oct 2026 08:52:09 GMT | https://github.com/unicode-org/icu4x |
| `idna` | `1.1.0` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:12:43 GMT | https://github.com/servo/rust-url/ |
| `idna_adapter` | `1.2.2` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:53:01 GMT | https://github.com/hsivonen/idna_adapter |
| `litemap` | `0.8.3` | Unicode-3.0 | transitive | no | no | Thu, 13 Aug 2026 23:27:58 GMT | https://github.com/unicode-org/icu4x |
| `nom` | `8.0.0` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:24:51 GMT | https://github.com/rust-bakery/nom |
| `potential_utf` | `0.1.6` | Unicode-3.0 | transitive | no | no | Thu, 13 Aug 2026 23:28:15 GMT | https://github.com/unicode-org/icu4x |
| `stable_deref_trait` | `1.2.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:56:40 GMT | https://github.com/storyyeller/stable_deref_trait |
| `synstructure` | `0.14.0` | MIT | transitive | no | no | Thu, 30 Jul 2026 19:43:06 GMT | https://github.com/mystor/synstructure |
| `tinystr` | `0.8.5` | Unicode-3.0 | transitive | no | no | Thu, 22 Oct 2026 08:51:50 GMT | https://github.com/unicode-org/icu4x |
| `url` | `2.5.8` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:12:34 GMT | https://github.com/servo/rust-url |
| `utf8_iter` | `1.1.0` | Apache-2.0 OR MIT | transitive | no | no | Thu, 29 Oct 2026 18:47:55 GMT | https://github.com/hsivonen/utf8_iter |
| `utf_types` | `1.0.0` | Apache-2.0 OR MIT | transitive | no | no | Thu, 29 Oct 2026 18:41:44 GMT | https://github.com/hsivonen/utf_types |
| `writeable` | `0.6.4` | Unicode-3.0 | transitive | no | no | Thu, 13 Aug 2026 23:28:10 GMT | https://github.com/unicode-org/icu4x |
| `yoke` | `0.8.4` | Unicode-3.0 | transitive | no | no | Thu, 22 Oct 2026 08:51:36 GMT | https://github.com/unicode-org/icu4x |
| `yoke-derive` | `0.8.4` | Unicode-3.0 | transitive | no | yes | Wed, 30 Sep 2026 13:19:40 GMT | https://github.com/unicode-org/icu4x |
| `zerofrom` | `0.1.8` | Unicode-3.0 | transitive | no | no | Sun, 28 Jun 2026 15:19:16 GMT | https://github.com/unicode-org/icu4x |
| `zerofrom-derive` | `0.1.8` | Unicode-3.0 | transitive | no | yes | Tue, 15 Sep 2026 21:39:22 GMT | https://github.com/unicode-org/icu4x |
| `zerotrie` | `0.2.5` | Unicode-3.0 | transitive | no | no | Thu, 13 Aug 2026 23:28:21 GMT | https://github.com/unicode-org/icu4x |
| `zerovec` | `0.11.9` | Unicode-3.0 | transitive | no | no | Thu, 22 Oct 2026 08:51:45 GMT | https://github.com/unicode-org/icu4x |
| `zerovec-derive` | `0.11.7` | Unicode-3.0 | transitive | no | yes | Thu, 22 Oct 2026 08:51:39 GMT | https://github.com/unicode-org/icu4x |

<!-- gate-zero:end -->
