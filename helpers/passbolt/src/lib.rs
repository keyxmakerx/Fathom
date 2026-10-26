//! **The four OpenPGP steps Fathom needs to read a Passbolt**, and the rule that keeps the
//! flagged crates away from every private key (owner's answer r34-passbolt v2 B, 2026-10-26).
//!
//! The rule, [`curve25519_only`]: every private-key step (opening a message, signing one) runs
//! with a key whose every part is Curve25519 (Ed25519 or X25519, legacy or RFC 9580). rpgp's RSA
//! (RUSTSEC-2023-0071) and the NIST curves' crypto-bigint 0.5 (RUSTSEC-2026-0387) are reached only
//! by keys of those kinds, measured with `cargo tree` on pgp 0.21.0 (r34-passbolt v2). A Passbolt
//! server's own key is usually RSA-3072; Fathom only encrypts to it and checks its signatures,
//! which are public-key steps.
//!
//! The helper holds no key between requests: the server sends the key each time, sealed under
//! `vault.key` at rest on its side. It has no network and no files, so a fault in these packages
//! cannot reach either while it runs. It does not protect the build (r34-passbolt-crates).

use pgp::composed::{
    Deserializable, EncryptionCaps, KeyType, Message, MessageBuilder, SecretKeyParamsBuilder,
    SignedPublicKey, SignedSecretKey, SubkeyParamsBuilder,
};
use pgp::crypto::ecc_curve::ECCCurve;
use pgp::crypto::hash::HashAlgorithm;
use pgp::crypto::sym::SymmetricKeyAlgorithm;
use pgp::types::{
    EcdhPublicParams, EddsaLegacyPublicParams, KeyDetails, Password, PublicParams, VerifyingKey,
};
use serde_json::{json, Map, Value};

/// The longest request or answer, in bytes. A Passbolt folder Fathom reads is small.
pub const MAX_FRAME: usize = 1024 * 1024;

/// Why a step failed. The words carry no secret.
#[derive(Debug, PartialEq, Eq)]
pub struct Refused(pub String);

fn refused(why: impl Into<String>) -> Refused {
    Refused(why.into())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn is_curve25519(p: &PublicParams) -> bool {
    matches!(
        p,
        PublicParams::EdDSALegacy(EddsaLegacyPublicParams::Ed25519 { .. })
            | PublicParams::Ed25519(_)
            | PublicParams::X25519(_)
            | PublicParams::ECDH(EcdhPublicParams::Curve25519Legacy { .. })
    )
}

/// True when the primary key and every subkey are Curve25519.
pub fn curve25519_only(key: &SignedSecretKey) -> bool {
    is_curve25519(key.primary_key.public_params())
        && key
            .secret_subkeys
            .iter()
            .all(|s| is_curve25519(s.key.public_params()))
        && key
            .public_subkeys
            .iter()
            .all(|s| is_curve25519(s.key.public_params()))
}

fn public_curve25519_only(key: &SignedPublicKey) -> bool {
    is_curve25519(key.primary_key.public_params())
        && key
            .public_subkeys
            .iter()
            .all(|s| is_curve25519(s.key.public_params()))
}

/// Read an armored private key, check its bindings, and refuse it unless it is Curve25519.
pub fn secret_key(armored: &str) -> Result<SignedSecretKey, Refused> {
    let (key, _) = SignedSecretKey::from_string(armored)
        .map_err(|_| refused("the private key is not one Fathom reads"))?;
    key.verify_bindings()
        .map_err(|_| refused("the private key's own signatures do not check"))?;
    if !curve25519_only(&key) {
        return Err(refused(
            "the private key is not Curve25519; Fathom uses only Curve25519 private keys",
        ));
    }
    Ok(key)
}

/// Read an armored public key and check its bindings. Any algorithm: Fathom only encrypts to it
/// and checks its signatures.
pub fn public_key(armored: &str) -> Result<SignedPublicKey, Refused> {
    let (key, _) = SignedPublicKey::from_string(armored)
        .map_err(|_| refused("the public key is not one Fathom reads"))?;
    key.verify_bindings()
        .map_err(|_| refused("the public key's own signatures do not check"))?;
    Ok(key)
}

fn fingerprint_of(f: &pgp::types::Fingerprint) -> String {
    hex(f.as_bytes())
}

/// A new key for Fathom's Passbolt account: an Ed25519 primary that certifies and signs, and an
/// X25519 (legacy ECDH) subkey that decrypts. No expiry and no passphrase, as Passbolt's setup
/// accepts (`PublicKeyValidationService::getStrictRules`, passbolt_api 5de65b8); the server seals
/// it under `vault.key` instead.
pub fn make_key(uid: &str) -> Result<(String, String, String), Refused> {
    if uid.is_empty() || uid.len() > 200 || uid.chars().any(char::is_control) {
        return Err(refused("the key's name"));
    }
    let mut enc = SubkeyParamsBuilder::default();
    enc.key_type(KeyType::ECDH(ECCCurve::Curve25519Legacy))
        .can_sign(false)
        .can_encrypt(EncryptionCaps::All)
        .can_authenticate(false);
    let mut params = SecretKeyParamsBuilder::default();
    params
        .key_type(KeyType::Ed25519Legacy)
        .can_certify(true)
        .can_sign(true)
        .can_encrypt(EncryptionCaps::None)
        .primary_user_id(uid.into())
        .preferred_symmetric_algorithms(
            [SymmetricKeyAlgorithm::AES256, SymmetricKeyAlgorithm::AES128]
                .into_iter()
                .collect(),
        )
        .preferred_hash_algorithms(
            [HashAlgorithm::Sha512, HashAlgorithm::Sha256]
                .into_iter()
                .collect(),
        )
        .subkeys(vec![enc
            .build()
            .map_err(|_| refused("could not make the key"))?]);
    let key = params
        .build()
        .map_err(|_| refused("could not make the key"))?
        .generate(rand::thread_rng())
        .map_err(|_| refused("could not make the key"))?;
    let public = SignedPublicKey::from(key.clone());
    let secret_text = key
        .to_armored_string(Default::default())
        .map_err(|_| refused("could not write the key"))?;
    let public_text = public
        .to_armored_string(Default::default())
        .map_err(|_| refused("could not write the key"))?;
    Ok((secret_text, public_text, fingerprint_of(&key.fingerprint())))
}

/// Sign `plain` with `secret` and encrypt it to `to`'s encryption key, armored. What Passbolt's
/// JWT login wants of its challenge (`JwtLoginController`, passbolt_api 5de65b8).
pub fn seal_for(secret: &str, to: &str, plain: &str) -> Result<String, Refused> {
    let me = secret_key(secret)?;
    let them = public_key(to)?;
    let mut rng = rand::thread_rng();
    let mut b = MessageBuilder::from_bytes("", plain.as_bytes().to_vec())
        .seipd_v1(&mut rng, SymmetricKeyAlgorithm::AES256);
    // A subkey that encrypts, as GnuPG lays out its keys; the primary only when there is none.
    let sub = them.public_subkeys.iter().find(|s| {
        s.key.algorithm().can_encrypt()
            && s.signatures
                .iter()
                .any(|sig| sig.key_flags().encrypt_comms())
    });
    match sub {
        Some(s) => b.encrypt_to_key(&mut rng, s),
        None if them.primary_key.algorithm().can_encrypt() => {
            b.encrypt_to_key(&mut rng, &them.primary_key)
        }
        None => return Err(refused("that public key cannot be encrypted to")),
    }
    .map_err(|_| refused("could not encrypt to that key"))?;
    b.sign(&me.primary_key, Password::empty(), HashAlgorithm::Sha512);
    b.to_armored_string(&mut rng, Default::default())
        .map_err(|_| refused("could not write the message"))
}

/// Open an armored message with `secret` (unlocked with `password`, empty when it has none).
/// When `signer` is given, the message must be signed by it, by its primary key or a subkey.
/// Answers the text and whether a signature was checked.
pub fn open(
    secret: &str,
    password: &str,
    data: &str,
    signer: Option<&str>,
) -> Result<(String, bool), Refused> {
    let me = secret_key(secret)?;
    let signer = signer.map(public_key).transpose()?;
    let (msg, _) = Message::from_string(data).map_err(|_| refused("not an OpenPGP message"))?;
    let mut msg = msg
        .decrypt(&Password::from(password), &me)
        .map_err(|_| refused("the message did not open with this key"))?;
    if msg.is_compressed() {
        msg = msg
            .decompress()
            .map_err(|_| refused("the message did not decompress"))?;
    }
    let bytes = msg
        .as_data_vec()
        .map_err(|_| refused("the message did not read"))?;
    let signed = match &signer {
        None => false,
        Some(k) => {
            let mut keys: Vec<&dyn VerifyingKey> = vec![&k.primary_key];
            keys.extend(k.public_subkeys.iter().map(|s| &s.key as &dyn VerifyingKey));
            if !keys.into_iter().any(|key| msg.verify(key).is_ok()) {
                return Err(refused("the message is not signed by the key it should be"));
            }
            true
        }
    };
    let text = String::from_utf8(bytes).map_err(|_| refused("the message is not text"))?;
    Ok((text, signed))
}

/// A key's fingerprint, whether it is private, and whether it is Curve25519 throughout.
pub fn key_info(armored: &str) -> Result<(String, bool, bool), Refused> {
    if let Ok((k, _)) = SignedSecretKey::from_string(armored) {
        return Ok((fingerprint_of(&k.fingerprint()), true, curve25519_only(&k)));
    }
    let k = public_key(armored)?;
    Ok((
        fingerprint_of(&k.fingerprint()),
        false,
        public_curve25519_only(&k),
    ))
}

fn field<'a>(m: &'a Map<String, Value>, k: &str) -> Result<&'a str, Refused> {
    m.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| refused(format!("the request has no {k}")))
}

fn opt_field<'a>(m: &'a Map<String, Value>, k: &str) -> Result<Option<&'a str>, Refused> {
    match m.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(refused(format!("the request's {k} is not text"))),
    }
}

/// One request, as the socket carries it, to one answer. Never panics on what it is sent.
pub fn answer(request: &[u8]) -> Vec<u8> {
    let out = match serde_json::from_slice::<Value>(request) {
        Ok(Value::Object(m)) => run(&m),
        _ => Err(refused("the request is not a JSON object")),
    };
    let v = match out {
        Ok(Value::Object(mut m)) => {
            m.insert("ok".into(), Value::Bool(true));
            Value::Object(m)
        }
        Ok(_) => json!({"ok": false, "error": "internal"}),
        Err(Refused(why)) => json!({"ok": false, "error": why}),
    };
    serde_json::to_vec(&v).unwrap_or_else(|_| br#"{"ok":false,"error":"internal"}"#.to_vec())
}

fn run(m: &Map<String, Value>) -> Result<Value, Refused> {
    let allowed: &[&str] = match field(m, "op")? {
        "ping" => &["op"],
        "make_key" => &["op", "uid"],
        "seal_for" => &["op", "secret", "to", "plain"],
        "open" => &["op", "secret", "password", "data", "signer"],
        "key_info" => &["op", "key"],
        _ => return Err(refused("unknown step")),
    };
    if let Some(k) = m.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(refused(format!("the request has an unknown field {k}")));
    }
    match field(m, "op")? {
        "ping" => Ok(json!({})),
        "make_key" => {
            let (secret, public, fingerprint) = make_key(field(m, "uid")?)?;
            Ok(json!({"secret": secret, "public": public, "fingerprint": fingerprint}))
        }
        "seal_for" => Ok(json!({
            "data": seal_for(field(m, "secret")?, field(m, "to")?, field(m, "plain")?)?
        })),
        "open" => {
            let (plain, signed) = open(
                field(m, "secret")?,
                opt_field(m, "password")?.unwrap_or(""),
                field(m, "data")?,
                opt_field(m, "signer")?,
            )?;
            Ok(json!({"plain": plain, "signed": signed}))
        }
        _ => {
            let (fingerprint, secret, curve25519) = key_info(field(m, "key")?)?;
            Ok(json!({"fingerprint": fingerprint, "secret": secret, "curve25519": curve25519}))
        }
    }
}

/// Read one frame: four bytes of length, big-endian, then that many bytes.
pub fn read_frame(r: &mut impl std::io::Read) -> std::io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too long",
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

pub fn write_frame(w: &mut impl std::io::Write, body: &[u8]) -> std::io::Result<()> {
    let len = u32::try_from(body.len())
        .ok()
        .filter(|l| (*l as usize) <= MAX_FRAME)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too long"))?;
    w.write_all(&len.to_be_bytes())?;
    w.write_all(body)?;
    w.flush()
}

/// The whole exchange on one connection: one request, one answer.
pub fn serve_one(stream: &mut (impl std::io::Read + std::io::Write)) -> std::io::Result<()> {
    let req = read_frame(stream)?;
    write_frame(stream, &answer(&req))
}
