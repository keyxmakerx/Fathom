#!/usr/bin/env python3
"""Golden vectors for the chain constructions, assembled from the DOCUMENT.

`docs/PHASE-2-STORAGE-DESIGN.md` §11.2 and §12.2, and `0009`'s two extra
labels.

THE POINT IS TWO INDEPENDENT ASSEMBLIES AGREEING.
-------------------------------------------------

This script is not a wrapper around the Rust code and must never become one.
Every message below is built here, in plain Python, from the text of §11.2 and
§12.2 -- its own `lp`, `u16_le`, `u32_le`, `u64_le`, HMAC-SHA-256 and
HKDF-Expand, no imports beyond `hashlib` and `hmac`. The Rust test
`crates/fathom-server/tests/chain_vectors.rs` holds the hex these values print
as LITERALS and recomputes them through `fathom_server::chain`. If the two
agree, two people reading the same specification laid the bytes out the same
way. If one of them is changed -- a length prefix dropped, a field reordered, a
label tidied -- they stop agreeing, and that is the whole control.

A test that called the Rust code to produce its expected value would pass for
any construction whatsoever, including a construction with `LP(metadata_binding)`
deleted from the seal. That is exactly what happened: the seal correction of
2026-09-12 was pinned by nothing, and removing it left every test green.

Run:  python3 crates/fathom-server/tests/vectors/gen_chain_vectors.py

It prints Rust `const` lines. Paste them into `chain_vectors.rs`; do not have
the test read this file, or a mistake here becomes agreement.
"""

import hashlib
import hmac as _hmac

# ---------------------------------------------------------------------------
# The primitives, from §11.2 and §12.1/§12.2
# ---------------------------------------------------------------------------


def lp(x: bytes) -> bytes:
    """LP(x) = u32_le(len(x)) || x  -- §11.2, "length-prefix every
    variable-length field"."""
    return u32_le(len(x)) + x


def u16_le(n: int) -> bytes:
    return n.to_bytes(2, "little")


def u32_le(n: int) -> bytes:
    return n.to_bytes(4, "little")


def u64_le(n: int) -> bytes:
    return n.to_bytes(8, "little")


def mac(key: bytes, message: bytes) -> bytes:
    """HMAC-SHA-256 -- §12.1."""
    return _hmac.new(key, message, hashlib.sha256).digest()


def hkdf_expand(prk: bytes, info: bytes, length: int = 32) -> bytes:
    """HKDF-SHA-256, **Expand only** -- §12.1: the chain key is already
    uniform, so Extract is skipped (`from_prk`, not `new`).

    RFC 5869's Expand: T(1) = HMAC(PRK, info || 0x01), and 32 bytes is one
    block of SHA-256 output, so the loop is one iteration.
    """
    assert length <= 32
    return mac(prk, info + b"\x01")[:length]


# ---------------------------------------------------------------------------
# The labels. §12.2's table owns these; code and that table must agree.
# ---------------------------------------------------------------------------

CHAIN_KEY_LABEL = b"fathom/chain/key/v1"
SITE_CHAIN_KEY_LABEL = b"fathom/chain/key/site/v1"
ORG_CHAIN_KEY_LABEL = b"fathom/chain/key/org/v1"
SITE_METADATA_KEY_LABEL = b"fathom/chain/key/site-metadata/v1"
KDF_SEAL_LABEL = b"fathom/chain/kdf/seal/v1"
KDF_CONTENT_LABEL = b"fathom/chain/kdf/content/v1"
TAG_SEAL = b"fathom/chain/seal/v1"
TAG_CONTENT = b"fathom/chain/content/v1"
TAG_PLAINTEXT = b"fathom/chain/plaintext/v1"
TAG_STORAGE = b"fathom/chain/storage/v1"
TAG_METADATA = b"fathom/chain/metadata/v1"
TAG_NO_CONTENT = b"fathom/chain/nocontent/v1"
TAG_GENESIS = b"fathom/chain/genesis/v1"
AAD_METADATA = b"fathom/chain/metadata/aead/v1"
KEY_ID_LABEL = b"fathom/key/id/v1"


# ---------------------------------------------------------------------------
# The fixed inputs. Chosen so that no two are equal and none is all-zero: a
# vector over zeros agrees with a construction that dropped the field.
# ---------------------------------------------------------------------------

CHAIN_MASTER = bytes(range(32))              # 00 01 02 ... 1f
DATA_KEY = bytes([0x11]) * 32                # whose id goes into storage_binding
TENANT = b"01JQZ0000000000000000000AA"
DESIGN = b"01JQZ0000000000000000000BB"
DEPLOYMENT = b"01JQZ0000000000000000000CC"

CHAIN_KEY_EPOCH = 7
SEQ = 4
DESIGN_VERSION = 3
PAYLOAD_SCHEMA_VERSION = 2
PAYLOAD = b"the estate"

KEY_EPOCH = 5
WRAP_VERSION = 1
AEAD_ALG_ID = 1
NONCE = bytes(range(0x20, 0x2C))             # 12 bytes
CIPHERTEXT = b"ciphertext-including-tag"

# Deliberately different from `METADATA_STORED`: the seal covers the bytes on
# disk, the binding covers what they mean, and a vector that used one value for
# both would agree with a construction that confused them.
METADATA_CANONICAL = b'{"actor":"01JQZ0000000000000000000AA","entry_type":"update"}'
METADATA_STORED = b"the-aead-blob-as-stored"

PREV_SEAL = bytes([0x33]) * 32
ENTRY_TYPE = b"update"

METADATA_KEY_EPOCH = 9


def key_id(key: bytes) -> bytes:
    """`HMAC-SHA-256(key, "fathom/key/id/v1")` truncated to 8 bytes --
    `src/crypto.rs`, and the only key-derived value that is not a key."""
    return mac(key, KEY_ID_LABEL)[:8]


# ---------------------------------------------------------------------------
# The constructions
# ---------------------------------------------------------------------------

# §12.2: chain_key_epoch_e = HKDF-Expand(chain_master,
#     info = LP(label) || LP(tenant_id) || LP(design_id) || u32(epoch), 32)
design_chain_key = hkdf_expand(
    CHAIN_MASTER,
    lp(CHAIN_KEY_LABEL) + lp(TENANT) + lp(DESIGN) + u32_le(CHAIN_KEY_EPOCH),
)
site_chain_key = hkdf_expand(
    CHAIN_MASTER,
    lp(SITE_CHAIN_KEY_LABEL) + lp(DEPLOYMENT) + u32_le(CHAIN_KEY_EPOCH),
)
org_chain_key = hkdf_expand(
    CHAIN_MASTER,
    lp(ORG_CHAIN_KEY_LABEL) + lp(TENANT) + u32_le(CHAIN_KEY_EPOCH),
)
site_metadata_key = hkdf_expand(
    CHAIN_MASTER,
    lp(SITE_METADATA_KEY_LABEL) + lp(DEPLOYMENT) + u32_le(CHAIN_KEY_EPOCH),
)

# §12.2's renamed KDF labels -- deliberately not the same literals as the
# in-MAC domain tags below.
k_seal = hkdf_expand(design_chain_key, KDF_SEAL_LABEL)
k_content = hkdf_expand(design_chain_key, KDF_CONTENT_LABEL)

# §11.2, in order.
plaintext_binding = mac(
    k_content,
    lp(TAG_PLAINTEXT)
    + lp(TENANT)
    + lp(DESIGN)
    + u64_le(DESIGN_VERSION)
    + u32_le(PAYLOAD_SCHEMA_VERSION)
    + lp(PAYLOAD),
)

storage_binding = mac(
    k_content,
    lp(TAG_STORAGE)
    + lp(key_id(DATA_KEY))
    + u32_le(KEY_EPOCH)
    + u32_le(WRAP_VERSION)
    + u16_le(AEAD_ALG_ID)
    + lp(NONCE)
    + lp(CIPHERTEXT),
)

content_hash = mac(
    k_content,
    lp(TAG_CONTENT) + lp(plaintext_binding) + lp(storage_binding),
)

# §11.2 corrected 2026-09-12: keyed over the PLAINTEXT metadata, stored in the
# clear beside the seal.
metadata_binding = mac(k_content, lp(TAG_METADATA) + lp(METADATA_CANONICAL))

# 0009: what both binding slots carry on an entry that binds no payload.
absent_content_binding = mac(k_content, lp(TAG_NO_CONTENT))

# §11.2, with the two corrections of 2026-09-12: the metadata AS STORED, then
# the keyed binding of its plaintext.
seal = mac(
    k_seal,
    lp(TAG_SEAL)
    + u32_le(CHAIN_KEY_EPOCH)
    + u64_le(SEQ)
    + lp(TENANT)
    + lp(DESIGN)
    + lp(PREV_SEAL)
    + lp(content_hash)
    + lp(ENTRY_TYPE)
    + lp(METADATA_STORED)
    + lp(metadata_binding),
)

# §11.2's genesis, read as the implementation reads it: the outer LP is how the
# value ENTERS the MAC, and the inner concatenation is length-prefixed.
genesis_design = hashlib.sha256(
    lp(TAG_GENESIS) + lp(TENANT) + lp(DESIGN)
).digest()
genesis_site = hashlib.sha256(
    lp(TAG_GENESIS) + lp(b"") + lp(DEPLOYMENT)
).digest()
genesis_org = hashlib.sha256(lp(TAG_GENESIS) + lp(TENANT) + lp(b"")).digest()

# 0009's associated data for an encrypted metadata column. `key_epoch` is
# `metadata_key_epoch` on an organisation entry and `chain_key_epoch` on a site
# one.
metadata_aad_org = (
    lp(AAD_METADATA) + lp(b"org") + lp(TENANT) + u64_le(SEQ) + u32_le(METADATA_KEY_EPOCH)
)
metadata_aad_site = (
    lp(AAD_METADATA)
    + lp(b"site")
    + lp(DEPLOYMENT)
    + u64_le(SEQ)
    + u32_le(CHAIN_KEY_EPOCH)
)


def rust(name: str, value: bytes) -> str:
    return f'const {name}: &str =\n    "{value.hex()}";'


if __name__ == "__main__":
    print("// Generated by tests/vectors/gen_chain_vectors.py -- paste, do not read.")
    for name, value in [
        ("DESIGN_CHAIN_KEY", design_chain_key),
        ("SITE_CHAIN_KEY", site_chain_key),
        ("ORG_CHAIN_KEY", org_chain_key),
        ("SITE_METADATA_KEY", site_metadata_key),
        ("K_SEAL", k_seal),
        ("K_CONTENT", k_content),
        ("PLAINTEXT_BINDING", plaintext_binding),
        ("STORAGE_BINDING", storage_binding),
        ("CONTENT_HASH", content_hash),
        ("METADATA_BINDING", metadata_binding),
        ("ABSENT_CONTENT_BINDING", absent_content_binding),
        ("SEAL", seal),
        ("GENESIS_DESIGN", genesis_design),
        ("GENESIS_SITE", genesis_site),
        ("GENESIS_ORG", genesis_org),
        ("METADATA_AAD_ORG", metadata_aad_org),
        ("METADATA_AAD_SITE", metadata_aad_site),
        ("DATA_KEY_ID", key_id(DATA_KEY)),
    ]:
        print(rust(name, value))
