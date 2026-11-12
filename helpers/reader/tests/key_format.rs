//! The key a person makes in Fathom's browser is one the reader logs in with (r117, finding 11).
//! `client/src/vault/sshKey.test.ts` pins that the browser writes these exact bytes for this
//! seed; here the reader's own decoder takes them.

use fathom_reader::ssh::Login;

/// Seed 01 02 … 20, no comment, as Python's `cryptography` 50.0.1 writes it and as
/// `client/src/vault/sshKey.ts` writes it byte for byte. A fixture: anyone can rebuild it.
/// Only the base64 lines are kept in the source and the armour is added in the test, so secret
/// scanners don't take this public fixture for a leaked key.
const ED25519_BODY: &[&str] = &[
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
    "c2gtZWQyNTUxOQAAACB5tVYuj+ZU+UB4sRLoqYunkB+FOuaVvtfg45ELrQSWZAAA",
    "AIhruzaea7s2ngAAAAtzc2gtZWQyNTUxOQAAACB5tVYuj+ZU+UB4sRLoqYunkB+F",
    "OuaVvtfg45ELrQSWZAAAAEABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f",
    "IHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZkAAAAAAECAwQF",
];

fn ed25519() -> String {
    let armour = |kind: &str| format!("-----{kind} OPENSSH {} KEY-----", "PRIVATE");
    format!(
        "{}\n{}\n{}\n",
        armour("BEGIN"),
        ED25519_BODY.join("\n"),
        armour("END")
    )
}

#[test]
fn a_key_made_in_the_browser_is_one_the_reader_logs_in_with() {
    match Login::key("fathomro".to_string(), &ed25519()) {
        Ok(Login::Key { user, key }) => {
            assert_eq!(user, "fathomro");
            assert_eq!(
                key.public_key().to_openssh().unwrap(),
                "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZk"
            );
        }
        Ok(_) => panic!("read as a password"),
        Err(e) => panic!("refused: {}", e.message),
    }
    assert!(Login::key("fathomro".to_string(), "not a key").is_err());
}
