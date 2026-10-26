# The Passbolt helper's closure

> **Measured 2026-10-26 by `scripts/closure-report.sh`, run in `helpers/passbolt/`, from `cargo
> metadata`, the fetched source trees and `static.crates.io`.**

**Approved by the owner on 2026-10-26**, sign-off card r34-passbolt-crates, answer A: "Lets do
approve with 124 and etc, BUT let this be an optional thing somehow if possible. Maybe it's
attached to the project, but it pulls all of this from git after the admin clarifies they do want
this support." The card measured rpgp (`pgp 0.21.0`, default features off) inside Fathom's own
workspace: 124 packages added, 33 of them second versions. The optional part is why this file is
here and not in `deps/decisions/`: the helper has **its own workspace and its own lockfile**, so
none of these reach Fathom's lock, its gates or its server image, and the compose `passbolt`
profile is what builds it.

Resolved on its own, the helper's lock holds **152 external packages** (149 compiled for Linux),
of which 131 are not in Fathom's lock at the same version; with no older Fathom versions to unify
with, only two crates have a second version (`serdect`, `syn`). 17 have a `build.rs` and 12 are
proc-macros, against ADR-0032 C4's cap of 12 build scripts: **the cap is overrun, as the card
said it would be**, and the sandbox around the running helper does not cover its build.
`smallvec` is pinned at 1.15.2 (Fathom's version) rather than 1.16.4, published 2026-10-23, inside
the cooldown.

These gates run over this lock (`scripts/gate-passbolt-helper.sh`, and CI's `passbolt-helper` job):
gate-zero against this directory, `cargo deny` with `helpers/passbolt/deny.toml`, `cargo audit`
with the two reasoned ignores the owner was shown (r34-passbolt v2), the cooldown, look-alikes
against `00-LOOKALIKES.md` here, and OSV.

## The closure

<!-- gate-zero:closure approved-by="the owner" date="2026-10-26" -->

| crate | version | licence | direct | build.rs | proc-macro | published | repository |
|---|---|---|---|---|---|---|---|
| `aead` | `0.5.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:48:48 GMT | https://github.com/RustCrypto/traits |
| `aes` | `0.8.4` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:45:54 GMT | https://github.com/RustCrypto/block-ciphers |
| `aes-gcm` | `0.10.3` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 18:15:33 GMT | https://github.com/RustCrypto/AEADs |
| `aes-kw` | `0.2.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:50:18 GMT | https://github.com/RustCrypto/key-wraps/tree/aes-kw |
| `argon2` | `0.5.3` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:46:45 GMT | https://github.com/RustCrypto/password-hashes/tree/master/argon2 |
| `autocfg` | `1.5.1` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 18:05:58 GMT | https://github.com/cuviper/autocfg |
| `base16ct` | `0.2.0` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:44:45 GMT | https://github.com/RustCrypto/formats/tree/master/base16ct |
| `base64` | `0.22.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 14:36:55 GMT | https://github.com/marshallpierce/rust-base64 |
| `base64ct` | `1.8.3` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:26:20 GMT | https://github.com/RustCrypto/formats |
| `bitfields` | `1.0.3` | MIT | transitive | no | no | Sun, 28 Jun 2026 17:27:58 GMT | https://github.com/gregorygaines/bitfields-rs |
| `bitfields-impl` | `1.0.3` | MIT | transitive | no | yes | Sun, 28 Jun 2026 17:27:55 GMT | https://github.com/gregorygaines/bitfields-rs |
| `bitvec` | `1.1.1` | MIT | transitive | no | no | Sun, 28 Jun 2026 17:25:22 GMT | https://github.com/bitvecto-rs/bitvec |
| `blake2` | `0.10.6` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:02:00 GMT | https://github.com/RustCrypto/hashes |
| `block-buffer` | `0.10.4` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:55:02 GMT | https://github.com/RustCrypto/utils |
| `block-padding` | `0.3.3` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:05:17 GMT | https://github.com/RustCrypto/utils |
| `blowfish` | `0.9.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:28:11 GMT | https://github.com/RustCrypto/block-ciphers |
| `buffer-redux` | `1.1.0` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 14:50:02 GMT | https://github.com/dignifiedquire/buffer-redux |
| `byteorder` | `1.5.0` | Unlicense OR MIT | transitive | no | no | Sun, 28 Jun 2026 15:18:27 GMT | https://github.com/BurntSushi/byteorder |
| `bytes` | `1.12.1` | MIT | transitive | no | no | Wed, 08 Jul 2026 10:01:30 GMT | https://github.com/tokio-rs/bytes |
| `camellia` | `0.1.0` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 18:32:36 GMT | https://github.com/RustCrypto/block-ciphers |
| `cast5` | `0.11.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:26:25 GMT | https://github.com/RustCrypto/block-ciphers |
| `cfb-mode` | `0.8.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:30:17 GMT | https://github.com/RustCrypto/block-modes |
| `cfg-if` | `1.0.5` | MIT OR Apache-2.0 | transitive | no | no | Wed, 16 Sep 2026 17:36:12 GMT | https://github.com/rust-lang/cfg-if |
| `cipher` | `0.4.4` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:53:24 GMT | https://github.com/RustCrypto/traits |
| `cmac` | `0.7.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:46:19 GMT | https://github.com/RustCrypto/MACs |
| `const-oid` | `0.9.6` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:36:13 GMT | https://github.com/RustCrypto/formats/tree/master/const-oid |
| `convert_case` | `0.10.0` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:04:07 GMT | https://github.com/rutrum/convert-case |
| `cpufeatures` | `0.2.17` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:31:03 GMT | https://github.com/RustCrypto/utils |
| `crc24` | `0.1.6` | MIT/Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:39:31 GMT | https://github.com/sellibitze/crc24-rs.git |
| `crypto-bigint` | `0.5.5` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:58:01 GMT | https://github.com/RustCrypto/crypto-bigint |
| `crypto-common` | `0.1.7` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:54:06 GMT | https://github.com/RustCrypto/traits |
| `ctr` | `0.9.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:31:42 GMT | https://github.com/RustCrypto/block-modes |
| `curve25519-dalek` | `4.1.3` | BSD-3-Clause | transitive | yes | no | Sun, 28 Jun 2026 18:38:30 GMT | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/curve25519-dalek |
| `curve25519-dalek-derive` | `0.1.1` | MIT/Apache-2.0 | transitive | no | yes | Sun, 28 Jun 2026 14:59:29 GMT | https://github.com/dalek-cryptography/curve25519-dalek |
| `cx448` | `0.1.1` | BSD-3-Clause | transitive | no | no | Sun, 28 Jun 2026 16:46:07 GMT | https://github.com/dignifiedquire/cx448 |
| `darling` | `0.20.11` | MIT | transitive | no | no | Sun, 28 Jun 2026 15:21:33 GMT | https://github.com/TedDriggs/darling |
| `darling_core` | `0.20.11` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:32:02 GMT | https://github.com/TedDriggs/darling |
| `darling_macro` | `0.20.11` | MIT | transitive | no | yes | Sun, 28 Jun 2026 16:31:59 GMT | https://github.com/TedDriggs/darling |
| `dbl` | `0.3.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:36:10 GMT | https://github.com/RustCrypto/utils |
| `der` | `0.7.10` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 15:15:30 GMT | https://github.com/RustCrypto/formats/tree/master/der |
| `derive_builder` | `0.20.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:33:36 GMT | https://github.com/colin-kiegel/rust-derive-builder |
| `derive_builder_core` | `0.20.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:10:17 GMT | https://github.com/colin-kiegel/rust-derive-builder |
| `derive_builder_macro` | `0.20.2` | MIT OR Apache-2.0 | transitive | no | yes | Sun, 28 Jun 2026 16:10:14 GMT | https://github.com/colin-kiegel/rust-derive-builder |
| `derive_more` | `2.1.1` | MIT | transitive | no | no | Sun, 28 Jun 2026 14:44:52 GMT | https://github.com/JelteF/derive_more |
| `derive_more-impl` | `2.1.1` | MIT | transitive | no | yes | Sun, 28 Jun 2026 14:44:31 GMT | https://github.com/JelteF/derive_more |
| `des` | `0.8.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:30:26 GMT | https://github.com/RustCrypto/block-ciphers |
| `digest` | `0.10.7` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:56:58 GMT | https://github.com/RustCrypto/traits |
| `dsa` | `0.6.3` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:07:09 GMT | https://github.com/RustCrypto/signatures/tree/master/dsa |
| `eax` | `0.5.0` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:13:25 GMT | https://github.com/RustCrypto/AEADs |
| `ecdsa` | `0.16.9` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:39:17 GMT | https://github.com/RustCrypto/signatures/tree/master/ecdsa |
| `ed25519` | `2.2.3` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 18:07:21 GMT | https://github.com/RustCrypto/signatures/tree/master/ed25519 |
| `ed25519-dalek` | `2.2.0` | BSD-3-Clause | transitive | no | no | Sun, 28 Jun 2026 18:36:22 GMT | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/ed25519-dalek |
| `elliptic-curve` | `0.13.8` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:37:23 GMT | https://github.com/RustCrypto/traits/tree/master/elliptic-curve |
| `ff` | `0.13.1` | MIT/Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:39:57 GMT | https://github.com/zkcrypto/ff |
| `fiat-crypto` | `0.2.9` | MIT OR Apache-2.0 OR BSD-1-Clause | transitive | no | no | Sun, 28 Jun 2026 17:04:38 GMT | https://github.com/mit-plv/fiat-crypto |
| `flate2` | `1.1.10` | MIT OR Apache-2.0 | transitive | no | no | Fri, 28 Aug 2026 04:35:23 GMT | https://github.com/rust-lang/flate2-rs |
| `fnv` | `1.0.7` | Apache-2.0 / MIT | transitive | no | no | Sun, 28 Jun 2026 15:17:34 GMT | https://github.com/servo/rust-fnv |
| `funty` | `2.0.0` | MIT | transitive | no | no | Sun, 28 Jun 2026 15:31:37 GMT | https://github.com/myrrlyn/funty |
| `generic-array` | `0.14.7` | MIT | transitive | yes | no | Sun, 28 Jun 2026 18:24:33 GMT | https://github.com/fizyk20/generic-array.git |
| `getrandom` | `0.2.17` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 18:10:42 GMT | https://github.com/rust-random/getrandom |
| `ghash` | `0.5.1` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:04:23 GMT | https://github.com/RustCrypto/universal-hashes |
| `group` | `0.13.0` | MIT/Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:11:33 GMT | https://github.com/zkcrypto/group |
| `heck` | `0.5.0` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:25:04 GMT | https://github.com/withoutboats/heck |
| `hex` | `0.4.3` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 14:38:40 GMT | https://github.com/KokaKiwi/rust-hex |
| `hkdf` | `0.12.4` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:37:29 GMT | https://github.com/RustCrypto/KDFs/ |
| `hmac` | `0.12.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:58:58 GMT | https://github.com/RustCrypto/MACs |
| `idea` | `0.5.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:31:23 GMT | https://github.com/RustCrypto/block-ciphers |
| `ident_case` | `1.0.1` | MIT/Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:31:30 GMT | https://github.com/TedDriggs/ident_case |
| `inout` | `0.1.4` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:21:02 GMT | https://github.com/RustCrypto/utils |
| `itoa` | `1.0.18` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:55:52 GMT | https://github.com/dtolnay/itoa |
| `k256` | `0.13.4` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 18:26:11 GMT | https://github.com/RustCrypto/elliptic-curves/tree/master/k256 |
| `keccak` | `0.1.6` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 15:56:17 GMT | https://github.com/RustCrypto/sponges/tree/master/keccak |
| `lazy_static` | `1.5.1` | MIT OR Apache-2.0 | transitive | no | no | Thu, 01 Oct 2026 07:18:55 GMT | https://github.com/rust-lang-nursery/lazy-static.rs |
| `libc` | `0.2.191` | MIT OR Apache-2.0 | transitive | yes | no | Fri, 16 Oct 2026 22:56:47 GMT | https://github.com/rust-lang/libc |
| `libm` | `0.2.16` | MIT | transitive | yes | no | Sun, 28 Jun 2026 15:39:54 GMT | https://github.com/rust-lang/compiler-builtins |
| `log` | `0.4.34` | MIT OR Apache-2.0 | transitive | no | no | Sat, 22 Aug 2026 11:44:29 GMT | https://github.com/rust-lang/log |
| `md-5` | `0.10.6` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:52:35 GMT | https://github.com/RustCrypto/hashes |
| `memchr` | `2.8.3` | Unlicense OR MIT | transitive | no | no | Wed, 08 Jul 2026 00:49:55 GMT | https://github.com/BurntSushi/memchr |
| `nom` | `8.0.0` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:24:51 GMT | https://github.com/rust-bakery/nom |
| `num-bigint-dig` | `0.8.6` | MIT/Apache-2.0 | transitive | yes | no | Sun, 28 Jun 2026 16:57:28 GMT | https://github.com/dignifiedquire/num-bigint |
| `num-integer` | `0.1.47` | MIT OR Apache-2.0 | transitive | no | no | Wed, 12 Aug 2026 00:11:59 GMT | https://github.com/rust-num/num-integer |
| `num-iter` | `0.1.46` | MIT OR Apache-2.0 | transitive | no | no | Tue, 07 Jul 2026 19:51:47 GMT | https://github.com/rust-num/num-iter |
| `num-traits` | `0.2.19` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 28 Jun 2026 14:49:37 GMT | https://github.com/rust-num/num-traits |
| `num_enum` | `0.7.6` | BSD-3-Clause OR MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:39:30 GMT | https://github.com/illicitonion/num_enum |
| `num_enum_derive` | `0.7.6` | BSD-3-Clause OR MIT OR Apache-2.0 | transitive | no | yes | Sun, 28 Jun 2026 15:19:15 GMT | https://github.com/illicitonion/num_enum |
| `ocb3` | `0.1.0` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:13:31 GMT | https://github.com/RustCrypto/AEADs |
| `once_cell` | `1.21.4` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 15:34:01 GMT | https://github.com/matklad/once_cell |
| `opaque-debug` | `0.3.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:23:14 GMT | https://github.com/RustCrypto/utils |
| `p256` | `0.13.2` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 18:40:04 GMT | https://github.com/RustCrypto/elliptic-curves/tree/master/p256 |
| `p384` | `0.13.1` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 18:40:03 GMT | https://github.com/RustCrypto/elliptic-curves/tree/master/p384 |
| `p521` | `0.13.3` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 18:33:04 GMT | https://github.com/RustCrypto/elliptic-curves/tree/master/p521 |
| `password-hash` | `0.5.0` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 18:00:57 GMT | https://github.com/RustCrypto/traits/tree/master/password-hash |
| `pem-rfc7468` | `0.7.0` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:56:03 GMT | https://github.com/RustCrypto/formats/tree/master/pem-rfc7468 |
| `pgp` | `0.21.0` | MIT OR Apache-2.0 | DIRECT | no | no | Sat, 03 Oct 2026 10:02:04 GMT | https://github.com/rpgp/rpgp |
| `pkcs1` | `0.7.5` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:48:36 GMT | https://github.com/RustCrypto/formats/tree/master/pkcs1 |
| `pkcs8` | `0.10.2` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:57:03 GMT | https://github.com/RustCrypto/formats/tree/master/pkcs8 |
| `polyval` | `0.6.2` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:03:55 GMT | https://github.com/RustCrypto/universal-hashes |
| `ppv-lite86` | `0.2.21` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:33:13 GMT | https://github.com/cryptocorrosion/cryptocorrosion |
| `primeorder` | `0.13.6` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 18:38:20 GMT | https://github.com/RustCrypto/elliptic-curves/tree/master/primeorder |
| `proc-macro2` | `1.0.107` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 19 Jul 2026 00:18:26 GMT | https://github.com/dtolnay/proc-macro2 |
| `quote` | `1.0.47` | MIT OR Apache-2.0 | transitive | yes | no | Sun, 19 Jul 2026 00:16:58 GMT | https://github.com/dtolnay/quote |
| `radium` | `0.7.0` | MIT | transitive | yes | no | Sun, 28 Jun 2026 16:47:46 GMT | https://github.com/bitvecto-rs/radium |
| `rand` | `0.8.8` | MIT OR Apache-2.0 | DIRECT | no | no | Tue, 25 Aug 2026 07:45:52 GMT | https://github.com/rust-random/rand |
| `rand_chacha` | `0.3.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:34:01 GMT | https://github.com/rust-random/rand |
| `rand_core` | `0.6.4` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:28:16 GMT | https://github.com/rust-random/rand |
| `replace_with` | `0.1.8` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:58:46 GMT | https://github.com/alecmocatta/replace_with |
| `rfc6979` | `0.4.0` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:33:06 GMT | https://github.com/RustCrypto/signatures/tree/master/rfc6979 |
| `ripemd` | `0.1.3` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:47:44 GMT | https://github.com/RustCrypto/hashes |
| `rsa` | `0.9.10` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 18:12:34 GMT | https://github.com/RustCrypto/RSA |
| `rustc_version` | `0.4.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:19:16 GMT | https://github.com/djc/rustc-version-rs |
| `rustversion` | `1.0.23` | MIT OR Apache-2.0 | transitive | no | yes | Tue, 07 Jul 2026 02:10:27 GMT | https://github.com/dtolnay/rustversion |
| `sec1` | `0.7.3` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:13:47 GMT | https://github.com/RustCrypto/formats/tree/master/sec1 |
| `semver` | `1.0.28` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:11:15 GMT | https://github.com/dtolnay/semver |
| `serde` | `1.0.229` | MIT OR Apache-2.0 | transitive | yes | no | Sat, 18 Jul 2026 23:05:14 GMT | https://github.com/serde-rs/serde |
| `serde_core` | `1.0.229` | MIT OR Apache-2.0 | transitive | yes | no | Sat, 18 Jul 2026 23:05:12 GMT | https://github.com/serde-rs/serde |
| `serde_derive` | `1.0.229` | MIT OR Apache-2.0 | transitive | no | yes | Sat, 18 Jul 2026 23:05:08 GMT | https://github.com/serde-rs/serde |
| `serde_json` | `1.0.154` | MIT OR Apache-2.0 | DIRECT | yes | no | Sun, 11 Oct 2026 15:31:47 GMT | https://github.com/serde-rs/json |
| `serdect` | `0.2.0` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:55:10 GMT | https://github.com/RustCrypto/formats/tree/master/serdect |
| `serdect` | `0.3.0` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:55:11 GMT | https://github.com/RustCrypto/formats |
| `sha1` | `0.10.7` | MIT OR Apache-2.0 | transitive | no | no | Fri, 10 Jul 2026 14:30:12 GMT | https://github.com/RustCrypto/hashes |
| `sha1-checked` | `0.10.0` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:13:18 GMT | https://github.com/RustCrypto/hashes |
| `sha2` | `0.10.9` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:17:30 GMT | https://github.com/RustCrypto/hashes |
| `sha3` | `0.10.9` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:30:03 GMT | https://github.com/RustCrypto/hashes |
| `signature` | `2.2.0` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:12:46 GMT | https://github.com/RustCrypto/traits/tree/master/signature |
| `smallvec` | `1.15.2` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 18:21:48 GMT | https://github.com/servo/rust-smallvec |
| `snafu` | `0.9.2` | MIT OR Apache-2.0 | transitive | no | no | Tue, 21 Jul 2026 17:52:52 GMT | https://github.com/shepmaster/snafu |
| `snafu-derive` | `0.9.2` | MIT OR Apache-2.0 | transitive | no | yes | Tue, 21 Jul 2026 17:52:50 GMT | https://github.com/shepmaster/snafu |
| `spin` | `0.9.9` | MIT | transitive | no | no | Mon, 13 Jul 2026 19:44:07 GMT | https://github.com/mvdnes/spin-rs.git |
| `spki` | `0.7.3` | Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 17:45:01 GMT | https://github.com/RustCrypto/formats/tree/master/spki |
| `strsim` | `0.11.1` | MIT | transitive | no | no | Sun, 28 Jun 2026 15:19:54 GMT | https://github.com/rapidfuzz/strsim-rs |
| `subtle` | `2.6.1` | BSD-3-Clause | transitive | no | no | Sun, 28 Jun 2026 16:11:14 GMT | https://github.com/dalek-cryptography/subtle |
| `syn` | `2.0.119` | MIT OR Apache-2.0 | transitive | no | no | Wed, 15 Jul 2026 00:23:50 GMT | https://github.com/dtolnay/syn |
| `syn` | `3.0.9` | MIT OR Apache-2.0 | transitive | no | no | Mon, 12 Oct 2026 15:04:10 GMT | https://github.com/dtolnay/syn |
| `tap` | `1.0.1` | MIT | transitive | no | no | Sun, 28 Jun 2026 16:02:46 GMT | https://github.com/myrrlyn/tap |
| `thiserror` | `2.0.21` | MIT OR Apache-2.0 | transitive | yes | no | Wed, 23 Sep 2026 20:24:08 GMT | https://github.com/dtolnay/thiserror |
| `thiserror-impl` | `2.0.21` | MIT OR Apache-2.0 | transitive | no | yes | Wed, 23 Sep 2026 20:24:06 GMT | https://github.com/dtolnay/thiserror |
| `twofish` | `0.7.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 17:32:01 GMT | https://github.com/RustCrypto/block-ciphers |
| `typenum` | `1.20.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 14:49:45 GMT | https://github.com/paholg/typenum |
| `unicode-ident` | `1.0.27` | (MIT OR Apache-2.0) AND Unicode-3.0 | transitive | no | no | Mon, 12 Oct 2026 04:20:29 GMT | https://github.com/dtolnay/unicode-ident |
| `unicode-segmentation` | `1.13.3` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:06:39 GMT | https://github.com/unicode-rs/unicode-segmentation |
| `unicode-xid` | `0.2.6` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:33:22 GMT | https://github.com/unicode-rs/unicode-xid |
| `universal-hash` | `0.5.1` | MIT OR Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 14:49:57 GMT | https://github.com/RustCrypto/traits |
| `version_check` | `0.9.5` | MIT/Apache-2.0 | transitive | no | no | Sun, 28 Jun 2026 16:22:07 GMT | https://github.com/SergioBenitez/version_check |
| `wasi` | `0.11.1+wasi-snapshot-preview1` | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | transitive | no | no | Sun, 28 Jun 2026 16:14:11 GMT | https://github.com/bytecodealliance/wasi |
| `wyz` | `0.5.1` | MIT | transitive | no | no | Sun, 28 Jun 2026 15:37:11 GMT | https://github.com/myrrlyn/wyz |
| `x25519-dalek` | `2.0.1` | BSD-3-Clause | transitive | no | no | Sun, 28 Jun 2026 18:34:07 GMT | https://github.com/dalek-cryptography/curve25519-dalek/tree/main/x25519-dalek |
| `zerocopy` | `0.8.63` | BSD-2-Clause OR Apache-2.0 OR MIT | transitive | yes | no | Tue, 13 Oct 2026 20:03:08 GMT | https://github.com/google/zerocopy |
| `zerocopy-derive` | `0.8.63` | BSD-2-Clause OR Apache-2.0 OR MIT | transitive | no | yes | Tue, 13 Oct 2026 20:01:59 GMT | https://github.com/google/zerocopy |
| `zeroize` | `1.9.1` | Apache-2.0 OR MIT | transitive | no | no | Tue, 06 Oct 2026 17:49:22 GMT | https://github.com/RustCrypto/utils |
| `zeroize_derive` | `1.5.0` | Apache-2.0 OR MIT | transitive | no | yes | Sun, 28 Jun 2026 17:43:35 GMT | https://github.com/RustCrypto/utils |
| `zlib-rs` | `0.6.8` | Zlib | transitive | no | no | Tue, 15 Sep 2026 13:10:01 GMT | https://github.com/trifectatechfoundation/zlib-rs |
| `zmij` | `1.0.23` | MIT | transitive | yes | no | Mon, 13 Jul 2026 12:58:54 GMT | https://github.com/dtolnay/zmij |

**152 external crates**, of which **3 direct**. **15 carry a `build.rs`** and **12 are proc-macros** — 27 of 152 run code at compile time, which is the number the August 2026 attack was about. Against `35` §5.1: **≤ 30 direct (3)**, **≤ 200 in the closure (152)**.

<!-- gate-zero:end -->
