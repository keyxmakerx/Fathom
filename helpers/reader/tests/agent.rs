//! The reader against a real SNMPv3 agent: net-snmp's `snmpd`, configured by
//! `scripts/ci/reader-snmpd.conf` with one read-only user per protocol Fathom offers and one it
//! refuses (MD5 with DES). CLAUDE.md rule 2: test against what a real device accepts.
//!
//! Runs only when `FATHOM_READER_TEST_AGENT` names the agent, as `address:port` (CI's `reader`
//! job starts one). The address must not be loopback: the reader refuses those, as it should.

use serde_json::{json, Value};

fn agent() -> Option<(String, u16)> {
    let v = std::env::var("FATHOM_READER_TEST_AGENT").ok()?;
    let (a, p) = v.rsplit_once(':')?;
    Some((a.to_string(), p.parse().ok()?))
}

fn ask(req: Value) -> Value {
    serde_json::from_slice(&fathom_reader::answer(&serde_json::to_vec(&req).unwrap())).unwrap()
}

fn job(addr: &str, port: u16, engine: Option<&str>, purposes: &[&str]) -> Value {
    json!({
        "version": 1,
        "device": "dev-1",
        "address": addr,
        "port": port,
        "ranges": [format!("{addr}/32")],
        "purposes": purposes,
        "engineId": engine,
    })
}

fn login(user: &str, auth: &str, a: &str, p: &str) -> Value {
    json!({"user": user, "auth": auth, "authPassword": a, "privPassword": p})
}

fn read(addr: &str, port: u16, engine: &str, purposes: &[&str], l: Value) -> Value {
    ask(
        json!({"op": "snmp_read", "protocol": 1, "job": job(addr, port, Some(engine), purposes), "login": l}),
    )
}

#[test]
fn reads_a_real_agent_with_every_offered_protocol_and_refuses_what_it_should() {
    let Some((addr, port)) = agent() else {
        eprintln!("FATHOM_READER_TEST_AGENT is not set; skipped");
        return;
    };

    // First contact sends no login, and only learns the engine.
    let first =
        ask(json!({"op": "snmp_read", "protocol": 1, "job": job(&addr, port, None, &["system"])}));
    assert_eq!(first["ok"], true, "{first}");
    assert_eq!(first["outcome"], "engine", "{first}");
    let engine = first["engineId"].as_str().unwrap().to_string();
    assert!(engine.len() >= 10, "{engine}");

    for (user, auth, a, p) in [
        ("fathom512", "sha512", "authpassword512", "privpassword512"),
        ("fathom256", "sha256", "authpassword256", "privpassword256"),
        ("fathom1", "sha1", "authpassword1x", "privpassword1x"),
    ] {
        let r = read(
            &addr,
            port,
            &engine,
            &["system", "inventory", "interfaces", "lldp", "mac", "arp"],
            login(user, auth, a, p),
        );
        assert_eq!(r["ok"], true, "{user}: {r}");
        assert_eq!(r["outcome"], "read", "{user}: {r}");
        assert_eq!(r["reader"], "local");
        assert_eq!(r["reading"]["system"]["name"], "fathom-ci", "{user}: {r}");
        assert!(r["reading"]["system"]["descr"]
            .as_str()
            .unwrap()
            .contains("Linux"));
        let ifs = r["reading"]["interfaces"].as_array().unwrap();
        assert!(ifs.iter().any(|i| i["descr"] == "lo"), "{user}: {ifs:?}");
        assert!(ifs.iter().all(|i| i["operStatus"].is_i64()), "{ifs:?}");
        assert_eq!(r["digest"].as_str().unwrap().len(), 64);
        assert_eq!(
            r["digest"],
            fathom_reader::digest(&r["reading"]),
            "the digest is over the reading as sent"
        );
        // A purpose the agent has no table for is an empty list, not a failure.
        assert!(
            r["failed"].as_object().unwrap().is_empty(),
            "{user}: {}",
            r["failed"]
        );
    }

    // A wrong password, a wrong privacy password, an unknown user, MD5: each refused once, by name.
    for (l, why) in [
        (
            login("fathom256", "sha256", "wrongpassword", "privpassword256"),
            "authentication password",
        ),
        (
            login("fathom256", "sha256", "authpassword256", "wrongprivacy"),
            "privacy password",
        ),
        (
            login(
                "nobody-here",
                "sha256",
                "authpassword256",
                "privpassword256",
            ),
            "does not know this",
        ),
        (
            login("fathommd5", "sha1", "authpasswordmd5", "privpasswordmd5"),
            "",
        ),
    ] {
        let r = read(&addr, port, &engine, &["system"], l);
        assert_eq!(r["outcome"], "failed", "{r}");
        assert_eq!(r["failure"]["code"], "login_refused", "{r}");
        assert!(
            r["failure"]["message"].as_str().unwrap().contains(why),
            "{r}"
        );
    }

    // An engine id that is not the device's stops before any login is sent.
    let r = read(
        &addr,
        port,
        "8000000001020304",
        &["system"],
        login("fathom256", "sha256", "authpassword256", "privpassword256"),
    );
    assert_eq!(r["failure"]["code"], "engine_changed", "{r}");
    assert_eq!(
        r["engineId"],
        engine.as_str(),
        "the new id comes back to be confirmed"
    );

    // An address outside the job's ranges is refused before anything is sent.
    let mut j = job(&addr, port, Some(&engine), &["system"]);
    j["ranges"] = json!(["198.51.100.0/24"]);
    let r = ask(
        json!({"op": "snmp_read", "protocol": 1, "job": j, "login": login("fathom256", "sha256", "authpassword256", "privpassword256")}),
    );
    assert_eq!(r["ok"], false);
    assert!(
        r["error"].as_str().unwrap().contains("not inside a range"),
        "{r}"
    );
}
