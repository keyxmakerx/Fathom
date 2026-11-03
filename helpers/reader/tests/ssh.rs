//! The reader against a real OpenSSH server that answers like a device (`scripts/ci/reader-sshd.sh`
//! and `reader-fake-device.sh`). CLAUDE.md rule 2: test against what a real server accepts.
//!
//! Runs only when `FATHOM_READER_TEST_SSH` names the server as `address:port`, and
//! `FATHOM_READER_TEST_SSH_DIR` the directory the script wrote its keys to. The address must not
//! be loopback: the reader refuses those, as it should.

use serde_json::{json, Value};

fn server() -> Option<(String, u16, String)> {
    let v = std::env::var("FATHOM_READER_TEST_SSH").ok()?;
    let dir = std::env::var("FATHOM_READER_TEST_SSH_DIR").ok()?;
    let (a, p) = v.rsplit_once(':')?;
    Some((a.to_string(), p.parse().ok()?, dir))
}

fn ask(req: Value) -> Value {
    serde_json::from_slice(&fathom_reader::answer(&serde_json::to_vec(&req).unwrap())).unwrap()
}

fn job(addr: &str, port: u16, platform: &str, key: Option<&str>) -> Value {
    json!({
        "version": 1,
        "device": "dev-1",
        "address": addr,
        "port": port,
        "ranges": [format!("{addr}/32")],
        "platform": platform,
        "hostKey": key,
    })
}

fn read(addr: &str, port: u16, key: &str, login: Value) -> Value {
    ask(
        json!({"op": "ssh_read", "protocol": 1, "job": job(addr, port, "junos-srx", Some(key)), "login": login}),
    )
}

/// What the fake device was asked, in order, since the last call.
fn sent() -> Vec<String> {
    let log = std::fs::read_to_string("/tmp/fathom-fake-device.log").unwrap_or_default();
    let _ = std::fs::write("/tmp/fathom-fake-device.log", "");
    log.lines().map(str::to_string).collect()
}

#[test]
fn reads_a_real_ssh_server_and_never_sends_more_than_it_should() {
    let Some((addr, port, dir)) = server() else {
        eprintln!("FATHOM_READER_TEST_SSH is not set; skipped");
        return;
    };
    let _ = sent();
    // The dictionaries the gate reads, from the repository (the image keeps them in /fathom).
    if std::env::var_os("FATHOM_READER_ROOT").is_none() {
        std::env::set_var(
            "FATHOM_READER_ROOT",
            concat!(env!("CARGO_MANIFEST_DIR"), "/../.."),
        );
    }

    // First contact learns the host key and sends no login, and so runs nothing.
    let first =
        ask(json!({"op": "ssh_read", "protocol": 1, "job": job(&addr, port, "junos-srx", None)}));
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["outcome"], "host_key", "{first}");
    let key = first["hostKey"].as_str().unwrap().to_string();
    assert!(key.starts_with("SHA256:") && key.len() == 50, "{key}");
    assert_eq!(first["keyType"], "ssh-ed25519");
    // The same fingerprint `ssh-keygen -l` prints for the server's key.
    let pubkey = std::fs::read_to_string(format!("{dir}/host_ed25519.pub")).unwrap();
    let parsed = russh::keys::PublicKey::from_openssh(pubkey.trim()).unwrap();
    assert_eq!(
        parsed.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
        key
    );
    assert!(
        sent().is_empty(),
        "nothing runs before the key is confirmed"
    );

    // A password login: the one fixed command runs, and its secrets never leave the reader.
    let r = read(
        &addr,
        port,
        &key,
        json!({"user": "fathomro", "password": "read-only-pw-7Qx"}),
    );
    assert_eq!(r["outcome"], "read", "{r}");
    assert_eq!(r["hostKey"], key.as_str());
    let out = &r["reading"]["outputs"][0];
    assert_eq!(out["command"], "show configuration | display set");
    assert_eq!(out["exit"], 0);
    let text = out["text"].as_str().unwrap();
    assert!(text.contains("set system host-name srx-lab"), "{text}");
    assert!(text.contains("10.20.0.1/24"), "{text}");
    assert!(
        !text.contains("$6$6nBQ1Gtk"),
        "the root hash left the reader: {text}"
    );
    assert!(
        !text.contains("$6$Kx9pL2mQ"),
        "a user's hash left the reader: {text}"
    );
    assert!(out["drops"].as_u64().unwrap() >= 2, "{out}");
    assert_eq!(sent(), vec!["show configuration | display set"]);

    // An Ed25519 key login reads the same.
    let k = std::fs::read_to_string(format!("{dir}/client_ed25519")).unwrap();
    let r = read(&addr, port, &key, json!({"user": "fathomro", "key": k}));
    assert_eq!(r["outcome"], "read", "{r}");
    assert_eq!(sent(), vec!["show configuration | display set"]);

    // A wrong password is refused once and never tried again.
    let r = read(
        &addr,
        port,
        &key,
        json!({"user": "fathomro", "password": "not-the-password"}),
    );
    assert_eq!(r["outcome"], "failed", "{r}");
    assert_eq!(r["failure"]["code"], "login_refused", "{r}");
    assert!(sent().is_empty());

    // A changed key stops the read before the login is sent, and names the key it saw.
    let other = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let r = read(
        &addr,
        port,
        other,
        json!({"user": "fathomro", "password": "read-only-pw-7Qx"}),
    );
    assert_eq!(r["outcome"], "failed", "{r}");
    assert_eq!(r["failure"]["code"], "host_key_changed", "{r}");
    assert_eq!(r["hostKey"], key.as_str(), "{r}");
    assert!(sent().is_empty());

    // An address outside the job's ranges is refused before any connection.
    let mut j = job(&addr, port, "junos-srx", Some(&key));
    j["ranges"] = json!(["198.51.100.0/24"]);
    let r = ask(json!({"op": "ssh_read", "protocol": 1, "job": j,
        "login": {"user": "fathomro", "password": "read-only-pw-7Qx"}}));
    assert_eq!(r["ok"], false, "{r}");
}
