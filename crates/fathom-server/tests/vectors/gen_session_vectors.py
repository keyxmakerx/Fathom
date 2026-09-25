#!/usr/bin/env python3
"""Golden vectors for the session layer, assembled from the DOCUMENT.

`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §4.2 (the challenge and the
per-request message), §4.3 (the row a session is, and the MAC under it), and
`docs/PHASE-2-STORAGE-DESIGN.md` §11.2 and §12.2 (length prefixes, the chain
key derivations, and the label table that owns every name below).

THE POINT IS TWO INDEPENDENT ASSEMBLIES AGREEING.
-------------------------------------------------

This script is not a wrapper around the Rust code and must never become one.
Every message below is built here, in plain Python, from the text of §4 -- its
own `lp`, `u32_le`, `u64_le`, SHA-256, HMAC-SHA-256, HKDF-Expand, its own
canonical-JSON emitter and its own P-256 arithmetic for the ES256 side.
`crates/fathom-server/tests/session_vectors.rs` holds the hex these values
print as LITERALS and recomputes them through `fathom_server::sessions`. If the
two agree, two people reading the same specification laid the bytes out the
same way. If one is changed -- a length prefix dropped, a field reordered, the
nonce quietly taken back out of `request_bytes` -- they stop agreeing, and that
is the whole control.

A test that called the Rust code to produce its expected value would pass for
any construction whatsoever, including one with `LP(nonce)` deleted from
`request_bytes` -- which is the exact field this build added to §4.2's layout,
because a single-use nonce that is not inside the signed bytes is not bound to
the signature at all.

Run:  python3 crates/fathom-server/tests/vectors/gen_session_vectors.py

It prints Rust `const` lines. Paste them into `session_vectors.rs`; do not have
the test read this file, or a mistake here becomes agreement.
"""

import hashlib
import hmac as _hmac

# ---------------------------------------------------------------------------
# The primitives, from storage §11.2 and §12.1
# ---------------------------------------------------------------------------


def lp(x: bytes) -> bytes:
    """LP(x) = u32_le(len(x)) || x."""
    return u32_le(len(x)) + x


def u32_le(n: int) -> bytes:
    return n.to_bytes(4, "little")


def u64_le(n: int) -> bytes:
    return (n % (1 << 64)).to_bytes(8, "little")


def sha256(message: bytes) -> bytes:
    return hashlib.sha256(message).digest()


def mac(key: bytes, message: bytes) -> bytes:
    return _hmac.new(key, message, hashlib.sha256).digest()


def hkdf_expand(prk: bytes, info: bytes, length: int = 32) -> bytes:
    """HKDF-SHA-256, Expand only -- storage §12.1's `from_prk`."""
    assert length <= 32
    return mac(prk, info + b"\x01")[:length]


# ---------------------------------------------------------------------------
# The labels. storage §12.2's table owns these; code and that table must agree.
# ---------------------------------------------------------------------------

TAG_SESSION_BIND = b"fathom/session/bind/v1"
TAG_SESSION_REQUEST = b"fathom/session/req/v1"
TAG_SESSION_TOKEN = b"fathom/session/token/v1"
TAG_SESSION_EVIDENCE = b"fathom/session/evidence/v1"

# 0014 section A: the keyed hash a claimed sign-in address is counted under,
# so the rate-limit table never holds a list of addresses that are not
# accounts.
KDF_SESSION_ADDRESS = b"fathom/session/kdf/address/v1"
TAG_SESSION_ADDRESS = b"fathom/session/address/v1"

# The row MAC reuses the authority layer's construction under the SITE-scoped
# row key (0013's departure 2, following 0012 §D for `account_keys`). Repeated
# here rather than imported from the authority vector script: an independent
# assembly that imports the other assembly is one assembly.
SITE_CHAIN_KEY_LABEL = b"fathom/chain/key/site/v1"
KDF_ROW = b"fathom/chain/kdf/row/v1"
TAG_ROW = b"fathom/row/v1"

# ---------------------------------------------------------------------------
# Fixed inputs. No two equal, none all-zero: a vector over zeros agrees with a
# construction that dropped the field.
# ---------------------------------------------------------------------------

CHAIN_MASTER = bytes(range(32))
CHAIN_KEY_EPOCH = 1

DEPLOYMENT = b"01JQZ0000000000000000000DD"
SESSION_ID = b"01JQZ0000000000000000000SS"
PRINCIPAL_ID = b"01JQZ0000000000000000000AA"
PRINCIPAL_KIND = b"steward"
EVIDENCE_KEY_ID = b"01JQZ0000000000000000000KK"

SERVER_NONCE = bytes([0x31]) * 32
REQUEST_NONCE = bytes([0x32]) * 32
TOKEN = bytes([0x33]) * 32
EVIDENCE_SIG = bytes([0x34]) * 64

METHOD = b"GET"
# Path AND query: this build signs `path_and_query`, because a query string
# left outside the signature is one an intermediary may rewrite.
PATH = b"/organisations/01JQZ0000000000000000000AA/capability?at=now"
BODY = b"the body this request actually carried"
UNIX_MS = 1_760_000_000_123
REQUEST_COUNTER = 9

# 0014 section A. A plausible address, and one whose length is not a round
# number, so a construction that dropped a length prefix does not agree by
# accident.
CLAIMED_ADDRESS = b"someone@example.invalid"
REVOCATION_REASON = b"signed_out"

ASSURANCE = b"A1"
ISSUED_AT = 1_760_000_000
EXPIRES_AT = 1_760_043_200
CHAIN_SEQ = 12
ROW_VERSION = 1
# A plausible instant between ISSUED_AT and EXPIRES_AT, not round.
TOTP_VERIFIED_AT = 1_760_000_050

# ---------------------------------------------------------------------------
# P-256, in plain Python, for the ES256 half
# ---------------------------------------------------------------------------

P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5


def inverse(value: int, modulus: int) -> int:
    return pow(value, modulus - 2, modulus)


def point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1 + A) * inverse(2 * y1, P) % P
    else:
        lam = (y2 - y1) * inverse(x2 - x1, P) % P
    x3 = (lam * lam - x1 - x2) % P
    y3 = (lam * (x1 - x3) - y1) % P
    return (x3, y3)


def point_mul(k: int, point):
    result = None
    addend = point
    while k:
        if k & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        k >>= 1
    return result


def on_curve(point) -> bool:
    x, y = point
    return (y * y - (x * x * x + A * x + B)) % P == 0


def sec1_uncompressed(point) -> bytes:
    x, y = point
    return b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")


def ecdsa_verify(public: bytes, message: bytes, signature: bytes) -> bool:
    """Plain ECDSA over SHA-256 -- no low-S rule, so that the low-S rule can be
    stated separately and seen to be this product's and not the algorithm's."""
    if len(signature) != 64 or len(public) != 65 or public[0] != 4:
        return False
    qx = int.from_bytes(public[1:33], "big")
    qy = int.from_bytes(public[33:], "big")
    if not on_curve((qx, qy)):
        return False
    r = int.from_bytes(signature[:32], "big")
    s = int.from_bytes(signature[32:], "big")
    if not (1 <= r < N and 1 <= s < N):
        return False
    e = int.from_bytes(sha256(message), "big")
    s_inv = inverse(s, N)
    u1 = e * s_inv % N
    u2 = r * s_inv % N
    point = point_add(point_mul(u1, (GX, GY)), point_mul(u2, (qx, qy)))
    if point is None:
        return False
    return point[0] % N == r


def is_low_s(signature: bytes) -> bool:
    return int.from_bytes(signature[32:], "big") <= N // 2


# The browser's session keypair, as a fixed scalar so that both assemblies
# start from the same number. §4.2's real one is generated non-extractable in
# WebCrypto and never leaves the browser; a vector needs one that does.
SESSION_SCALAR = bytes([0x21]) * 32
D = int.from_bytes(SESSION_SCALAR, "big")
assert 1 <= D < N
SESSION_POINT = point_mul(D, (GX, GY))
SESSION_PUBKEY = sec1_uncompressed(SESSION_POINT)

# The signature the Rust side produces over `request_bytes` with that key.
# ECDSA here is deterministic (`ecdsa 0.17.0` derives the ephemeral scalar per
# RFC 6979), so it is a fixed value -- and this script VERIFIES it rather than
# reproducing it, which is the independent check that matters: a wrong
# `request_bytes` on either side makes this verification fail.
SIGNATURE_OVER_REQUEST_BYTES = bytes.fromhex(
    "f7287814e9e2082c43eed17e320b25e0f016c610aacfc187c5240cf1c7e8774b"
    "2f910812429571d9122bc2c1930fc96c843ebc1ab854444ba884b3f7702215df"
)

# ---------------------------------------------------------------------------
# Canonical JSON, from `fathom-canon`'s own rules: keys in sorted order, no
# spaces, and a trailing newline. Written out here rather than reached for,
# because the row MAC covers it.
# ---------------------------------------------------------------------------


def canon_str(s: str) -> str:
    out = '"'
    for c in s:
        if c == '"':
            out += '\\"'
        elif c == "\\":
            out += "\\\\"
        elif c == "\n":
            out += "\\n"
        elif c == "\r":
            out += "\\r"
        elif c == "\t":
            out += "\\t"
        elif c == "\b":
            out += "\\b"
        elif c == "\f":
            out += "\\f"
        elif ord(c) < 0x20:
            out += "\\u%04x" % ord(c)
        else:
            out += c
    return out + '"'


def canon(value) -> bytes:
    def emit(v) -> str:
        if v is None:
            return "null"
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, int):
            return str(v)
        if isinstance(v, str):
            return canon_str(v)
        if isinstance(v, dict):
            # `fathom_canon::Json::Obj` is a BTreeMap, so the order is the
            # keys' own, sorted.
            return "{" + ",".join(
                canon_str(k) + ":" + emit(v[k]) for k in sorted(v)
            ) + "}"
        raise TypeError(v)

    return (emit(value) + "\n").encode()


def hexs(b: bytes) -> str:
    return b.hex()


# ---------------------------------------------------------------------------
# The constructions
# ---------------------------------------------------------------------------

# §4.2, with the tag length-prefixed (see `sessions::session_challenge` on why
# this build prefixes a tag that §4.2 writes bare).
session_challenge = sha256(
    lp(TAG_SESSION_BIND) + lp(SESSION_PUBKEY) + lp(SERVER_NONCE) + lp(DEPLOYMENT)
)

# §4.2's per-request message, WITH the nonce -- the one departure, and the
# reason for it is in `sessions::request_bytes`.
body_digest = sha256(BODY)
request_bytes = (
    lp(TAG_SESSION_REQUEST)
    + lp(SESSION_ID)
    + lp(METHOD)
    + lp(PATH)
    + lp(body_digest)
    + lp(REQUEST_NONCE)
    + u64_le(UNIX_MS)
    + u64_le(REQUEST_COUNTER)
)

token_hash = sha256(lp(TAG_SESSION_TOKEN) + lp(TOKEN))

evidence_digest = sha256(
    lp(TAG_SESSION_EVIDENCE) + lp(session_challenge) + lp(EVIDENCE_SIG)
)

# The row MAC. `K_row_site` is derived from the SITE chain key, which is itself
# derived from the chain master -- two HKDF steps, and the label on the second
# is the authority layer's, because this is the same construction on a row that
# is account-scoped in the same way (0013 departure 2).
site_chain_key = hkdf_expand(
    CHAIN_MASTER, lp(SITE_CHAIN_KEY_LABEL) + lp(DEPLOYMENT) + u32_le(CHAIN_KEY_EPOCH)
)
k_row_site = hkdf_expand(site_chain_key, KDF_ROW)

# 0014 section A's claimed-address key, expanded from the SAME site chain key
# under a label of its own -- the rule storage 12.2 states for when a label is
# warranted: a new USE of one key, not a new key.
k_addr = hkdf_expand(site_chain_key, KDF_SESSION_ADDRESS)
claimed_address_key = mac(k_addr, lp(TAG_SESSION_ADDRESS) + lp(CLAIMED_ADDRESS))

# 0014 section D's revocation row: the same row_seal construction under the
# same key, on a different table name, so a row lifted between the two does
# not verify where it lands.
revocation_row_state = canon(
    {
        "principal_id": PRINCIPAL_ID.decode(),
        "reason": REVOCATION_REASON.decode(),
        "session_id": SESSION_ID.decode(),
    }
)
revocation_row_mac = mac(
    k_row_site,
    lp(TAG_ROW)
    + lp(b"session_revocations")
    + lp(SESSION_ID)
    + u64_le(CHAIN_SEQ)
    + u32_le(ROW_VERSION)
    + lp(revocation_row_state),
)

row_state_dict = {
    "assertion_digest": hexs(evidence_digest),
    "assurance": ASSURANCE.decode(),
    "bound_nonce": hexs(SERVER_NONCE),
    "evidence_key_id": EVIDENCE_KEY_ID.decode(),
    "evidence_sig": hexs(EVIDENCE_SIG),
    "expires_at": EXPIRES_AT,
    "issued_at": ISSUED_AT,
    "principal_id": PRINCIPAL_ID.decode(),
    "principal_kind": PRINCIPAL_KIND.decode(),
    "session_pubkey": hexs(SESSION_PUBKEY),
    "token_hash": hexs(token_hash),
    "totp_verified_at": TOTP_VERIFIED_AT,
}
row_state = canon(row_state_dict)

row_mac = mac(
    k_row_site,
    lp(TAG_ROW)
    + lp(b"sessions")
    + lp(SESSION_ID)
    + u64_le(CHAIN_SEQ)
    + u32_le(ROW_VERSION)
    + lp(row_state),
)

# A row from before `totp_verified_at` existed: the key is left out, not
# written as null, so an old seal still recomputes unchanged.
row_state_no_totp_verified_at = canon(
    {k: v for k, v in row_state_dict.items() if k != "totp_verified_at"}
)
row_mac_no_totp_verified_at = mac(
    k_row_site,
    lp(TAG_ROW)
    + lp(b"sessions")
    + lp(SESSION_ID)
    + u64_le(CHAIN_SEQ)
    + u32_le(ROW_VERSION)
    + lp(row_state_no_totp_verified_at),
)

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def rust(name: str, value: bytes) -> str:
    """A Rust `const &str`, wrapped so that rustfmt has nothing to say about
    it. A long hex literal is split with `\\` continuations, which Rust joins
    back into one string with no whitespace."""
    text = value.hex()
    width = 96
    if len(text) <= width:
        return f'const {name}: &str = "{text}";'
    chunks = [text[i : i + width] for i in range(0, len(text), width)]
    body = "\\\n     ".join(chunks)
    return f'const {name}: &str = "{body}";'


if __name__ == "__main__":
    assert on_curve(SESSION_POINT), "the fixed session key must be on the curve"
    if ecdsa_verify(SESSION_PUBKEY, request_bytes, SIGNATURE_OVER_REQUEST_BYTES):
        assert is_low_s(SIGNATURE_OVER_REQUEST_BYTES), "this product signs low-s only"
    else:
        print(
            "// NOTE: SIGNATURE_OVER_REQUEST_BYTES does not verify over the\n"
            "// request_bytes this script assembled. Either the Rust changed the\n"
            "// message, or this constant has not been filled in from the Rust\n"
            "// side yet -- the signature is the ONE value this script cannot\n"
            "// produce, because RFC 6979's nonce derivation is the signer's.\n"
        )

    print("// Generated by tests/vectors/gen_session_vectors.py -- paste, do not read.")
    for name, value in [
        ("SESSION_PUBKEY", SESSION_PUBKEY),
        ("SESSION_CHALLENGE", session_challenge),
        ("BODY_DIGEST", body_digest),
        ("REQUEST_BYTES", request_bytes),
        ("TOKEN_HASH", token_hash),
        ("EVIDENCE_DIGEST", evidence_digest),
        ("SITE_CHAIN_KEY", site_chain_key),
        ("K_ROW_SITE", k_row_site),
        ("K_ADDR", k_addr),
        ("CLAIMED_ADDRESS_KEY", claimed_address_key),
        ("REVOCATION_ROW_STATE", revocation_row_state),
        ("REVOCATION_ROW_MAC", revocation_row_mac),
        ("ROW_STATE", row_state),
        ("ROW_MAC", row_mac),
        ("ROW_STATE_NO_TOTP_VERIFIED_AT", row_state_no_totp_verified_at),
        ("ROW_MAC_NO_TOTP_VERIFIED_AT", row_mac_no_totp_verified_at),
        ("SIGNATURE", SIGNATURE_OVER_REQUEST_BYTES),
    ]:
        print(rust(name, value))
