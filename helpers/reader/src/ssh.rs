//! SSH reads (ADR-0082 §4.1 and §4.4; r87-reader-packages: russh 0.65.0 on ring). One `exec` per
//! command from the platform's fixed list ([`crate::commands`]), no PTY, no shell, no agent, no
//! port forwarding. Everything a device prints goes through the gate ([`crate::gate`]) here.
//!
//! The host key is the SSH version of the SNMP engine id:
//! - with no confirmed key in the job, the reader completes the key exchange, notes the server's
//!   key, and closes the connection **before any login is sent** (`outcome: "host_key"`);
//! - with one, a different key stops the read before the login is sent (`host_key_changed`), and
//!   the new key's fingerprint is answered so a person can be asked to confirm it.
//!
//! A login is tried once. A refusal is answered, never retried, so the reader never spends the
//! lockout budget an engineer needs (ADR-0045 §2.3).

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use russh::client;
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg};
use russh::ChannelMsg;

use crate::commands::Platform;
use crate::gate;

/// The most a command's output may be, before the gate. The answer's frame is 1 MiB, and the
/// JSON around the text adds a little.
pub const MAX_OUTPUT: usize = 640 * 1024;

pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

pub fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure {
        code,
        message: message.into(),
    }
}

/// How the reader logs in, for one job only.
pub enum Login {
    Password {
        user: String,
        password: String,
    },
    /// An OpenSSH private key. RSA keys are refused (r87, third tick: the reader never uses an
    /// RSA private key, so RUSTSEC-2023-0071 cannot reach it).
    Key {
        user: String,
        key: Box<PrivateKey>,
    },
}

impl Login {
    pub fn key(user: String, openssh: &str) -> Result<Login, Failure> {
        let key = russh::keys::decode_secret_key(openssh, None).map_err(|_| {
            fail(
                "bad_login",
                "the login's key is not an unencrypted OpenSSH key",
            )
        })?;
        match key.algorithm() {
            russh::keys::Algorithm::Ed25519 | russh::keys::Algorithm::Ecdsa { .. } => {
                Ok(Login::Key {
                    user,
                    key: Box::new(key),
                })
            }
            _ => Err(fail(
                "bad_login",
                "the reader logs in with an Ed25519 or ECDSA key; RSA keys are refused",
            )),
        }
    }
}

/// One command's gated output.
pub struct Ran {
    pub command: &'static str,
    pub text: String,
    pub drops: usize,
    pub incomplete: bool,
    pub exit: Option<u32>,
}

pub enum Outcome {
    /// No key was confirmed yet: this is the device's, and nothing else was sent.
    HostKey {
        fingerprint: String,
        algorithm: String,
    },
    Read {
        fingerprint: String,
        ran: Vec<Ran>,
    },
}

/// The fingerprint form OpenSSH prints: `SHA256:` and unpadded base64.
pub fn fingerprint(key: &russh::keys::PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

struct Seen {
    expected: Option<String>,
    got: Arc<Mutex<Option<(String, String)>>>,
}

impl client::Handler for Seen {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // A certificate is not a key anyone confirmed; it is refused like a changed key.
        let russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            return Ok(false);
        };
        let fp = fingerprint(key);
        let alg = key.algorithm().to_string();
        *self.got.lock().unwrap_or_else(|e| e.into_inner()) = Some((fp.clone(), alg));
        // With no confirmed key, accept the exchange only so the key can be shown; the caller
        // closes the connection before any login goes out.
        Ok(match &self.expected {
            None => true,
            Some(want) => *want == fp,
        })
    }
}

/// Reads one device. `deadline` bounds the whole job.
pub fn read(
    peer: SocketAddr,
    platform: &'static Platform,
    expected: Option<String>,
    login: Option<Login>,
    deadline: Instant,
) -> Result<Outcome, Failure> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|e| fail("internal", format!("the reader could not start: {e}")))?;
    let left = deadline.saturating_duration_since(Instant::now());
    rt.block_on(async move {
        match tokio::time::timeout(left, session(peer, platform, expected, login)).await {
            Ok(r) => r,
            Err(_) => Err(fail(
                "timeout",
                "the device did not finish answering in time",
            )),
        }
    })
}

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        client_id: russh::SshId::Standard("SSH-2.0-Fathom_reader".into()),
        inactivity_timeout: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    })
}

async fn session(
    peer: SocketAddr,
    platform: &'static Platform,
    expected: Option<String>,
    login: Option<Login>,
) -> Result<Outcome, Failure> {
    let got = Arc::new(Mutex::new(None));
    let handler = Seen {
        expected: expected.clone(),
        got: Arc::clone(&got),
    };
    let seen = || got.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let connected = client::connect(config(), peer, handler).await;
    let mut handle = match connected {
        Ok(h) => h,
        Err(e) => {
            // The key check said no: a key was seen and it was not the confirmed one.
            if let (Some((fp, _)), Some(want)) = (seen(), expected.as_ref()) {
                if &fp != want {
                    return Err(fail(
                        "host_key_changed",
                        format!(
                            "the device's SSH host key is now {fp}; someone must confirm it again"
                        ),
                    ));
                }
            }
            return Err(fail(
                "unreachable",
                format!("could not open SSH: {}", words(&e)),
            ));
        }
    };
    let Some((fingerprint, algorithm)) = seen() else {
        return Err(fail("unreachable", "the device showed no host key"));
    };
    let Some(_) = expected else {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        return Ok(Outcome::HostKey {
            fingerprint,
            algorithm,
        });
    };

    let Some(login) = login else {
        return Err(fail("bad_login", "the request has no login"));
    };
    let auth = match login {
        Login::Password { user, password } => handle.authenticate_password(user, password).await,
        Login::Key { user, key } => {
            let key = PrivateKeyWithHashAlg::new(Arc::new(*key), None);
            handle.authenticate_publickey(user, key).await
        }
    };
    match auth {
        Ok(r) if r.success() => {}
        Ok(_) => {
            return Err(fail(
                "login_refused",
                "the device refused the login; it was not tried again",
            ))
        }
        Err(e) => return Err(fail("unreachable", format!("SSH stopped: {}", words(&e)))),
    }

    let mut ran = Vec::new();
    for command in platform.commands {
        ran.push(run(&handle, command).await?);
    }
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;

    let mut out = Vec::new();
    for r in ran {
        let (command, bytes, incomplete, exit) = r;
        let g = gate::gate(platform.dict, &bytes).map_err(|e| fail("gate", e))?;
        out.push(Ran {
            command,
            text: g.text,
            drops: g.drops,
            incomplete,
            exit,
        });
    }
    Ok(Outcome::Read {
        fingerprint,
        ran: out,
    })
}

type Raw = (&'static str, Vec<u8>, bool, Option<u32>);

/// One `exec`, no PTY. Standard error is kept apart and never answered: it can echo what the
/// device thought of the command, nothing the reading needs.
async fn run(handle: &client::Handle<Seen>, command: &'static str) -> Result<Raw, Failure> {
    let mut ch = handle.channel_open_session().await.map_err(|e| {
        fail(
            "refused",
            format!("the device would not open a session: {}", words(&e)),
        )
    })?;
    ch.exec(true, command).await.map_err(|e| {
        fail(
            "refused",
            format!("the device would not run it: {}", words(&e)),
        )
    })?;
    let mut out = Vec::new();
    let mut incomplete = false;
    let mut exit = None;
    while let Some(msg) = ch.wait().await {
        match msg {
            ChannelMsg::Data { data } => {
                let room = MAX_OUTPUT.saturating_sub(out.len());
                if data.len() > room {
                    out.extend_from_slice(&data[..room]);
                    incomplete = true;
                    break;
                }
                out.extend_from_slice(&data);
            }
            ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
            ChannelMsg::Failure => {
                return Err(fail("refused", format!("the device refused `{command}`")))
            }
            // The exit status comes after the end of output, so only a close ends the wait.
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    let _ = ch.close().await;
    if incomplete {
        // Never hand the gate half a line: a secret cut in two might not be recognised.
        let end = out.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        out.truncate(end);
    }
    Ok((command, out, incomplete, exit))
}

/// Error words with nothing from the device echoed back.
fn words(e: &russh::Error) -> String {
    let s = e.to_string();
    s.chars().take(160).collect()
}
