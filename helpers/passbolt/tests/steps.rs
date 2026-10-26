//! The four steps against each other, against GnuPG (what a Passbolt server signs and encrypts
//! with: php-gnupg, passbolt_api 5de65b8 `src/Utility/OpenPGP/Backends/Gnupg.php`), and the
//! Curve25519 rule against keys a real install could hold.

use std::io::Write;
use std::process::{Command, Stdio};

use fathom_passbolt_helper::{answer, key_info, make_key, open, seal_for, secret_key};
use pgp::composed::{KeyType, SecretKeyParamsBuilder};
use pgp::crypto::ecc_curve::ECCCurve;

#[test]
fn a_message_sealed_for_one_key_opens_with_it_and_checks_the_signer() {
    let (a_sec, a_pub, a_fp) = make_key("Fathom").unwrap();
    let (b_sec, b_pub, _) = make_key("Passbolt stand-in").unwrap();
    assert_eq!(a_fp.len(), 40);
    let sealed = seal_for(&a_sec, &b_pub, r#"{"version":"1.0.0"}"#).unwrap();
    assert!(sealed.starts_with("-----BEGIN PGP MESSAGE-----"));
    let (plain, signed) = open(&b_sec, "", &sealed, Some(&a_pub)).unwrap();
    assert_eq!((plain.as_str(), signed), (r#"{"version":"1.0.0"}"#, true));
    // Without a signer named, it opens and says nothing was checked.
    assert!(!open(&b_sec, "", &sealed, None).unwrap().1);
    // The wrong signer, or the wrong key, is a refusal.
    let (_, c_pub, _) = make_key("someone else").unwrap();
    assert!(open(&b_sec, "", &sealed, Some(&c_pub)).is_err());
    assert!(open(&a_sec, "", &sealed, None).is_err());
    assert_eq!(key_info(&a_pub).unwrap(), (a_fp.clone(), false, true));
    assert_eq!(key_info(&a_sec).unwrap(), (a_fp, true, true));
}

fn generated(kind: KeyType) -> String {
    let mut p = SecretKeyParamsBuilder::default();
    p.key_type(kind)
        .can_certify(true)
        .can_sign(true)
        .primary_user_id("other".into());
    p.build()
        .unwrap()
        .generate(rand::thread_rng())
        .unwrap()
        .to_armored_string(Default::default())
        .unwrap()
}

#[test]
fn a_private_key_that_is_not_curve25519_is_refused_before_any_step() {
    for kind in [
        KeyType::Rsa(2048),
        KeyType::ECDSA(ECCCurve::P256),
        KeyType::ECDSA(ECCCurve::P384),
    ] {
        let sec = generated(kind);
        let Err(err) = secret_key(&sec) else {
            panic!("refused")
        };
        assert!(err.0.contains("not Curve25519"), "{}", err.0);
        let (_, b_pub, _) = make_key("b").unwrap();
        assert!(seal_for(&sec, &b_pub, "x").is_err());
        assert!(!key_info(&sec).unwrap().2);
    }
}

#[test]
fn the_socket_answer_refuses_what_it_does_not_know() {
    let a = |s: &str| String::from_utf8(answer(s.as_bytes())).unwrap();
    assert!(a("[]").contains(r#""ok":false"#));
    assert!(a(r#"{"op":"export_all"}"#).contains("unknown step"));
    assert!(a(r#"{"op":"make_key","uid":"x","extra":1}"#).contains("unknown field"));
    let made = a(r#"{"op":"make_key","uid":"Fathom"}"#);
    assert!(made.contains(r#""ok":true"#) && made.contains("BEGIN PGP PRIVATE KEY BLOCK"));
}

// ---- GnuPG, as a Passbolt server runs it ----

struct Gpg(std::path::PathBuf);

impl Gpg {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "fathom-pb-gpg-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(dir)
    }

    fn run(&self, args: &[&str], input: &str) -> String {
        let mut child = Command::new("gpg")
            .arg("--homedir")
            .arg(&self.0)
            .args([
                "--batch",
                "--yes",
                "--pinentry-mode",
                "loopback",
                "--passphrase",
                "",
            ])
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("gpg is installed (CI installs it; Passbolt's server uses it)");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "gpg {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    }
}

impl Drop for Gpg {
    fn drop(&mut self) {
        let _ = Command::new("gpgconf")
            .arg("--homedir")
            .arg(&self.0)
            .args(["--kill", "all"])
            .status();
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn gnupg_with_an_rsa_3072_server_key_and_fathom_understand_each_other() {
    let g = Gpg::new();
    // Passbolt's "generate keys" page (updated 2026-06-16) makes the server key rsa3072.
    g.run(
        &[
            "--quick-generate-key",
            "Passbolt Server <server@example.org>",
            "rsa3072",
            "default",
            "never",
        ],
        "",
    );
    let server_pub = g.run(&["--armor", "--export", "server@example.org"], "");
    let (fathom_sec, fathom_pub, fathom_fp) = make_key("Fathom").unwrap();
    g.run(&["--import"], &fathom_pub);
    // GnuPG reads Fathom's key as Passbolt's setup would store it.
    let listed = g.run(
        &["--with-colons", "--fingerprint", &fathom_fp.to_uppercase()],
        "",
    );
    assert!(
        listed.contains("ed25519") && listed.contains("cv25519"),
        "{listed}"
    );

    // The challenge: Fathom signs and encrypts to the RSA server key; GnuPG opens it and checks.
    let sealed = seal_for(&fathom_sec, &server_pub, "challenge-text").unwrap();
    let opened = g.run(&["--decrypt"], &sealed);
    assert_eq!(opened, "challenge-text");

    // The answer: GnuPG signs with the RSA key and encrypts to Fathom; Fathom opens and checks.
    let answer = g.run(
        &[
            "--armor",
            "--trust-model",
            "always",
            "--local-user",
            "server@example.org",
            "--recipient",
            &fathom_fp,
            "--sign",
            "--encrypt",
        ],
        "token-text",
    );
    let (plain, signed) = open(&fathom_sec, "", &answer, Some(&server_pub)).unwrap();
    assert_eq!((plain.as_str(), signed), ("token-text", true));
    let (_, rsa, curve) = key_info(&server_pub).unwrap();
    assert!(!rsa && !curve);
}
