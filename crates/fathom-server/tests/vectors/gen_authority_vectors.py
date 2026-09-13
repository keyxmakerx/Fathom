#!/usr/bin/env python3
"""Golden vectors for the authority layer, assembled from the DOCUMENT.

`docs/PHASE-2-ADMIN-AND-AUDIT-DESIGN.md` §3.3 (the signed messages), §3.4 (the
row seal, the live digest, the head seal), §3.2 (the key fingerprint) and §6.1
(the organisation id), plus this build's own labels for the acts §3 names
without giving bytes for.

THE POINT IS TWO INDEPENDENT ASSEMBLIES AGREEING.
-------------------------------------------------

This script is not a wrapper around the Rust code and must never become one.
Every message below is built here, in plain Python, from the text of §3 -- its
own `lp`, `u32_le`, `u64_le`, SHA-256, HMAC-SHA-256, HKDF-Expand and its own
P-256 arithmetic for the ECDSA side. `crates/fathom-server/tests/
authority_vectors.rs` holds the hex these values print as LITERALS and
recomputes them through `fathom_server::authority`. If the two agree, two
people reading the same specification laid the bytes out the same way. If one
is changed -- a length prefix dropped, a field reordered, a label tidied --
they stop agreeing, and that is the whole control.

A test that called the Rust code to produce its expected value would pass for
any construction whatsoever, including one with `LP(granter_key_fpr)` deleted
from `second_bytes` -- which is the exact field §3's correction of 2026-09-12
exists to put there.

Run:  python3 crates/fathom-server/tests/vectors/gen_authority_vectors.py

It prints Rust `const` lines. Paste them into `authority_vectors.rs`; do not
have the test read this file, or a mistake here becomes agreement.

THE WYCHEPROOF HALF
-------------------

`ecdsa_secp256r1_sha256_p1363_test.json` and `ecdsa_secp256r1_sha256_test.json`
from `C2SP/wycheproof` (raw.githubusercontent.com, fetched 2026-09-12) are read
from disk if present beside this script, or fetched. A curated handful of cases
is emitted as Rust literals **with the outcome this product must produce**,
which is not always Wycheproof's own verdict: a Wycheproof-valid signature with
a high `s` is a signature this product refuses, because §3's correction admits
exactly one encoding per act. This script classifies each case's `s` itself
rather than copying a verdict.
"""

import hashlib
import hmac as _hmac
import json
import os
import sys

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

TAG_KEY_FPR = b"fathom/key/fpr/v1"
TAG_ORG_ID = b"fathom/org/id/v1"
TAG_GRANT = b"fathom/grant/v1"
TAG_GRANT_SECOND = b"fathom/grant/second/v1"
TAG_GRANT_REVOKE = b"fathom/grant/revoke/v1"
TAG_GRANT_SUSPEND = b"fathom/grant/suspend/v1"
TAG_GRANT_UNSUSPEND = b"fathom/grant/unsuspend/v1"
TAG_KEY_SUCCESSION = b"fathom/key/succession/v1"
KDF_ROW = b"fathom/chain/kdf/row/v1"
TAG_ROW = b"fathom/row/v1"
TAG_AUTHHEAD_LIVE = b"fathom/authhead/live/v1"
TAG_AUTHHEAD_SEAL = b"fathom/authhead/seal/v1"

# The chain-key derivation this layer's subkeys hang off, from storage §12.2
# and 0009. Repeated here rather than imported: an independent assembly that
# imports the other assembly is one assembly.
ORG_CHAIN_KEY_LABEL = b"fathom/chain/key/org/v1"
KDF_SEAL = b"fathom/chain/kdf/seal/v1"

# ---------------------------------------------------------------------------
# Fixed inputs. No two equal, none all-zero: a vector over zeros agrees with a
# construction that dropped the field.
# ---------------------------------------------------------------------------

CHAIN_MASTER = bytes(range(32))
CHAIN_KEY_EPOCH = 1

ORGANISATION = b"01JQZ0000000000000000000AA"
SCOPE = b"01JQZ0000000000000000000BB"
SUBJECT = b"01JQZ0000000000000000000CC"
GRANTER = b"01JQZ0000000000000000000DD"
GRANT_ID = b"01JQZ0000000000000000000EE"
ACCOUNT = b"01JQZ0000000000000000000FF"

ROOT_PUBKEY_FPR = bytes([0x41]) * 32
SUBJECT_KEY_FPR = bytes([0x42]) * 32
GRANTER_KEY_FPR = bytes([0x43]) * 32
OLD_KEY_FPR = bytes([0x44]) * 32
NEW_KEY_FPR = bytes([0x45]) * 32

CAPABILITY = b"steward"
EFFECTIVE_FROM = 1_760_000_000
EXPIRES_AT = 1_790_000_000
AUTH_EPOCH = 7
AT_UNIX = 1_770_000_000

ID_SALT = bytes([0x5A]) * 16

# One authority row, for the row seal.
ROW_TABLE = b"scope_grants"
ROW_ID = GRANT_ID
ROW_CHAIN_SEQ = 4
ROW_VERSION = 1
ROW_STATE = b'{"capability":"steward"}\n'

# The live set: two grants, deliberately given OUT of sorted order here,
# because §3.4 says `sorted(live grants)` and the Rust sorts rather than
# trusting its caller.
LIVE = [
    (b"01JQZ0000000000000000000GG", bytes([0x61]) * 32),
    (b"01JQZ0000000000000000000EE", bytes([0x62]) * 32),
]
HEAD_CHAIN_SEQ = 9

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


# The fixed test key. A private scalar, written out rather than derived, so
# that both assemblies start from the same number.
PRIVATE_SCALAR = bytes([0x07]) * 32
D = int.from_bytes(PRIVATE_SCALAR, "big")
assert 1 <= D < N
PUBLIC_POINT = point_mul(D, (GX, GY))
PUBLIC_KEY = sec1_uncompressed(PUBLIC_POINT)

# The signature the Rust side produces over GRANT_BYTES with that key. ECDSA
# here is deterministic (`ecdsa 0.17.0` derives the ephemeral scalar per RFC
# 6979), so it is a fixed value -- and this script VERIFIES it rather than
# reproducing it, which is the independent check that matters: a wrong
# `grant_bytes` on either side makes this verification fail.
SIGNATURE_OVER_GRANT_BYTES = bytes.fromhex(
    "1ed49eab8aa694e63551a54fa72c6be4b0e89181b39b1fe0eb8b49ab320bc5a0"
    "6df3b0c915318c899188879b0e69b5cc4122df16f510afcd1b5d22409de4794f"
)

# ---------------------------------------------------------------------------
# The constructions
# ---------------------------------------------------------------------------

key_fingerprint = sha256(lp(TAG_KEY_FPR) + lp(PUBLIC_KEY))

# §6.1, with the one deviation `authority::derive_organisation_id` documents:
# the first 128 bits of the digest, Crockford-encoded the way every other id in
# this product is, rather than the first 26 characters of a base32 rendering of
# the whole digest (which `Ulid::decode` refuses three times in four).
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid_encode(value: int) -> str:
    out = []
    for _ in range(26):
        out.append(CROCKFORD[value & 0x1F])
        value >>= 5
    return "".join(reversed(out))


org_id_digest = sha256(lp(TAG_ORG_ID) + lp(PUBLIC_KEY) + lp(ID_SALT))
organisation_id = ulid_encode(int.from_bytes(org_id_digest[:16], "big"))

grant_bytes = (
    lp(TAG_GRANT)
    + lp(ORGANISATION)
    + lp(ROOT_PUBKEY_FPR)
    + lp(SCOPE)
    + lp(SUBJECT)
    + lp(SUBJECT_KEY_FPR)
    + lp(CAPABILITY)
    + lp(GRANTER)
    + lp(GRANTER_KEY_FPR)
    + u64_le(EFFECTIVE_FROM)
    + u64_le(EXPIRES_AT)
    + u32_le(AUTH_EPOCH)
)

# §3, CORRECTED: LP(H(grant_bytes)) || LP(granter_key_fpr). NOT H(granter_sig).
second_bytes = lp(TAG_GRANT_SECOND) + lp(sha256(grant_bytes)) + lp(GRANTER_KEY_FPR)

revoke_bytes = (
    lp(TAG_GRANT_REVOKE)
    + lp(ORGANISATION)
    + lp(GRANT_ID)
    + lp(sha256(grant_bytes))
    + u64_le(AT_UNIX)
)

suspend_bytes = (
    lp(TAG_GRANT_SUSPEND)
    + lp(ORGANISATION)
    + lp(GRANT_ID)
    + lp(sha256(grant_bytes))
    + u64_le(AT_UNIX)
)

unsuspend_bytes = (
    lp(TAG_GRANT_UNSUSPEND)
    + lp(ORGANISATION)
    + lp(GRANT_ID)
    + lp(sha256(grant_bytes))
    + u64_le(AT_UNIX)
)

succession_bytes = (
    lp(TAG_KEY_SUCCESSION)
    + lp(ACCOUNT)
    + lp(OLD_KEY_FPR)
    + lp(NEW_KEY_FPR)
    + u64_le(AT_UNIX)
)

# The subkeys. The organisation chain key is 0009's; `K_row` is §3.4's third
# subkey beside `K_seal` and `K_content`.
org_chain_key = hkdf_expand(
    CHAIN_MASTER, lp(ORG_CHAIN_KEY_LABEL) + lp(ORGANISATION) + u32_le(CHAIN_KEY_EPOCH)
)
k_row = hkdf_expand(org_chain_key, KDF_ROW)
k_seal = hkdf_expand(org_chain_key, KDF_SEAL)

row_seal = mac(
    k_row,
    lp(TAG_ROW)
    + lp(ROW_TABLE)
    + lp(ROW_ID)
    + u64_le(ROW_CHAIN_SEQ)
    + u32_le(ROW_VERSION)
    + lp(ROW_STATE),
)

live_sorted = sorted(LIVE, key=lambda entry: entry[0])
live_digest = mac(
    k_row,
    lp(TAG_AUTHHEAD_LIVE)
    + lp(ORGANISATION)
    + u32_le(AUTH_EPOCH)
    + u32_le(len(live_sorted))
    + b"".join(lp(grant_id) + lp(seal) for grant_id, seal in live_sorted),
)

head_seal = mac(
    k_seal,
    lp(TAG_AUTHHEAD_SEAL)
    + lp(ORGANISATION)
    + u32_le(AUTH_EPOCH)
    + u64_le(HEAD_CHAIN_SEQ)
    + lp(live_digest),
)

# ---------------------------------------------------------------------------
# Wycheproof
# ---------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
WYCHEPROOF = {
    "p1363": (
        "ecdsa_secp256r1_sha256_p1363_test.json",
        "https://raw.githubusercontent.com/C2SP/wycheproof/main/testvectors_v1/"
        "ecdsa_secp256r1_sha256_p1363_test.json",
    ),
    "der": (
        "ecdsa_secp256r1_sha256_test.json",
        "https://raw.githubusercontent.com/C2SP/wycheproof/main/testvectors_v1/"
        "ecdsa_secp256r1_sha256_test.json",
    ),
}


def load_wycheproof(which):
    name, url = WYCHEPROOF[which]
    path = os.path.join(HERE, name)
    if os.path.exists(path):
        return json.load(open(path))
    try:
        import urllib.request

        with urllib.request.urlopen(url, timeout=60) as response:
            return json.loads(response.read())
    except Exception as e:  # noqa: BLE001 -- reported, never swallowed
        print(f"// WYCHEPROOF UNREACHABLE ({which}): {type(e).__name__} {e}", file=sys.stderr)
        return None


def expected_outcome(public: bytes, message: bytes, signature: bytes) -> str:
    """What THIS PRODUCT must answer, stated as a rule rather than copied from
    Wycheproof's verdict.

    The order matters and is the order `authority::verify_es256` applies:
    length, then scalar range, then the low-S rule -- which is this product's
    and not the algorithm's -- and only then the curve arithmetic. A high-`s`
    signature that also fails to verify is reported as `HighS`, because that is
    the check that reaches it first.
    """
    if len(signature) != 64:
        return "WrongLength"
    r = int.from_bytes(signature[:32], "big")
    s = int.from_bytes(signature[32:], "big")
    if r == 0 or s == 0 or r >= N or s >= N:
        return "Malformed"
    if not is_low_s(signature):
        return "HighS"
    return "Ok" if ecdsa_verify(public, message, signature) else "DoesNotVerify"


def wycheproof_cases():
    """A curated handful, each with the outcome THIS PRODUCT must produce."""
    out = []
    p1363 = load_wycheproof("p1363")
    if p1363 is not None:
        group = p1363["testGroups"][0]
        public = bytes.fromhex(group["publicKey"]["uncompressed"])
        picked = {"valid": 0, "invalid": 0, "size": 0}
        for test in group["tests"]:
            sig = bytes.fromhex(test["sig"])
            msg = bytes.fromhex(test["msg"])
            expected = expected_outcome(public, msg, sig)
            if test["result"] == "valid" and len(sig) == 64 and picked["valid"] < 3:
                # Wycheproof says valid; this product says valid only if `s` is
                # low. Assert the algorithm agrees it is a real signature, so
                # that a refusal here is this product's rule and not damage.
                assert ecdsa_verify(public, msg, sig), test["tcId"]
                out.append((test["tcId"], public, msg, sig, expected, test["comment"]))
                picked["valid"] += 1
            elif test["result"] == "invalid" and len(sig) == 64 and picked["invalid"] < 3:
                assert not ecdsa_verify(public, msg, sig), test["tcId"]
                out.append((test["tcId"], public, msg, sig, expected, test["comment"]))
                picked["invalid"] += 1
            elif test["result"] == "invalid" and len(sig) != 64 and picked["size"] < 2:
                out.append((test["tcId"], public, msg, sig, expected, test["comment"]))
                picked["size"] += 1

    # And the twin Wycheproof does not carry: the SAME valid case with `s`
    # negated. Wycheproof's p1363 group holds no high-`s` valid signature, and
    # the low-S rule is this product's own, so the vector for it is derived
    # here -- from a Wycheproof case, by the one operation that makes the
    # malleable pair, rather than invented.
    if out:
        tc_id, public, msg, sig, _expected, _comment = out[0]
        high = sig[:32] + ((N - int.from_bytes(sig[32:], "big")) % N).to_bytes(32, "big")
        assert ecdsa_verify(public, msg, high), "the twin is a valid ECDSA signature"
        assert expected_outcome(public, msg, high) == "HighS"
        out.append(
            (
                tc_id,
                public,
                msg,
                high,
                "HighS",
                "the (r, -s) twin of the case above, derived here: valid ECDSA, refused",
            )
        )

    der = load_wycheproof("der")
    if der is not None:
        group = der["testGroups"][0]
        public = bytes.fromhex(group["publicKey"]["uncompressed"])
        for test in group["tests"]:
            if test["result"] == "valid":
                # A DER encoding of a signature that IS valid. Refused by
                # length, which is how §3's "never DER" is enforced rather
                # than merely stated.
                sig = bytes.fromhex(test["sig"])
                out.append(
                    (
                        test["tcId"],
                        public,
                        bytes.fromhex(test["msg"]),
                        sig,
                        expected_outcome(public, bytes.fromhex(test["msg"]), sig),
                        "DER encoding of a valid signature",
                    )
                )
                break
    return out


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
    assert on_curve(PUBLIC_POINT), "the fixed test key must be on the curve"
    assert ecdsa_verify(PUBLIC_KEY, grant_bytes, SIGNATURE_OVER_GRANT_BYTES), (
        "the pinned signature does not verify over the grant_bytes this script "
        "assembled. Either the Rust changed the message or this script did."
    )
    assert is_low_s(SIGNATURE_OVER_GRANT_BYTES), "this product signs low-s only"

    print("// Generated by tests/vectors/gen_authority_vectors.py -- paste, do not read.")
    for name, value in [
        ("PUBLIC_KEY", PUBLIC_KEY),
        ("KEY_FINGERPRINT", key_fingerprint),
        ("GRANT_BYTES", grant_bytes),
        ("SECOND_BYTES", second_bytes),
        ("REVOKE_BYTES", revoke_bytes),
        ("SUSPEND_BYTES", suspend_bytes),
        ("UNSUSPEND_BYTES", unsuspend_bytes),
        ("SUCCESSION_BYTES", succession_bytes),
        ("ORG_CHAIN_KEY", org_chain_key),
        ("K_ROW", k_row),
        ("K_SEAL", k_seal),
        ("ROW_SEAL", row_seal),
        ("LIVE_DIGEST", live_digest),
        ("HEAD_SEAL", head_seal),
        ("SIGNATURE", SIGNATURE_OVER_GRANT_BYTES),
    ]:
        print(rust(name, value))
    print(f'const ORGANISATION_ID: &str = "{organisation_id}";')

    print("\n// Wycheproof, curated. (tcId, expected outcome, comment)")
    for tc_id, public, msg, sig, expected, comment in wycheproof_cases():
        print(
            f'    // tcId {tc_id}: {comment}\n'
            f'    ("{public.hex()}", "{msg.hex()}", "{sig.hex()}", "{expected}"),'
        )
