use fathom_ingest::redact::looks_like_credential;

#[test]
fn probe() {
    let cases: Vec<(&str, &str)> = vec![
        ("ed25519 pub", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHc7VXKQ0mV1xY9Jw2s4pR8tLzB6nQeF3aG5hK8dM2vT fw-pull@srx-a"),
        ("rsa pub", "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7vbqajDhA4bxDDcXSxpZQ2mFOL3l1nQeF3aG5hK8dM2vTqPzR1sWuYvXcNbMfKjHgTdRfEwQaZsXlPoIuYtRe fw-pull@srx-a"),
        ("sha256 hex", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
        ("junos ver", "21.4R3-S5"),
        ("eos ver", "4.32.2F"),
        ("signed url", "https://fathom.example.com/fw/srx-a/junos-srx-21.4R3-S5.tgz?exp=1789000000&sig=Yk3nQ7pR2sVwXzA9bC1dEf4Gh6Ij8Kl0"),
        ("signed url path only", "https://fw.example.com/d/8f2a1c/junos.tgz"),
        ("model", "SRX345"),
        ("desc with psk", "psk: hunter2"),
    ];
    for (name, v) in cases {
        println!("{name} => {}", looks_like_credential(v));
    }
}
