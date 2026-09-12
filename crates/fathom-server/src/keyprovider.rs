//! Where a 32-byte root key comes from — ADR-0043 §3, all three shapes.
//!
//! Two roots are loaded through this one interface and they are deliberately
//! different keys: the **master key**, which wraps the tenant keys that wrap
//! the design keys (`docs/PHASE-2-STORAGE-DESIGN.md` §4), and the **chain
//! master**, from which every per-design chain key is derived (§6's B5 fix:
//! *"the chain key is distinct from the master hierarchy, sits behind the same
//! provider interface, and never lives in PostgreSQL"*).
//!
//! # The three shapes, and why there are only three
//!
//! - **`file:///path/to/master.key`** — the default, and what ADR-0043 §2
//!   decided after reading seven self-hostable products in their own
//!   repositories: *"in their default self-hosted configuration, every one of
//!   them holds the key in a file or a config value."*
//! - **`command:///path/to/prog`** — Fathom runs it and reads the key from
//!   its standard output. **This is the load-bearing one**: AWS KMS, Google,
//!   Azure, HashiCorp Vault, CyberArk and Delinea all become a `command://`
//!   wrapper the operator supplies, so the SDK lives in the operator's
//!   container and never in `Cargo.lock`.
//! - **`env://NAME`** — supported, and documented as discouraged in that
//!   order. OWASP's Cryptographic Storage guidance, quoted in ADR-0043 §2:
//!   *"Avoid storing keys in environment variables, as these can be
//!   accidentally exposed."*
//!
//! # What this module does not claim
//!
//! ADR-0043 §5, both sentences and in this order: a stolen database dump, a
//! stolen replica, last night's SQL backup or an account with `SELECT` on
//! every table yields ciphertext for design contents — **and** anyone who can
//! read files as the Fathom user has both halves. The server decrypts designs
//! in normal operation because it has to serve them
//! (`docs/PHASE-2-STORAGE-DESIGN.md` §2a).

use core::fmt;
use std::path::{Path, PathBuf};

use crate::crypto::{Key32, KEY_LEN};

/// A root key is a [`Key32`] like every other key in this system, and is
/// spelled with its own name at the call sites that load one so that "the
/// master key" and "a design key" are not the same word.
///
/// **32 bytes, not a tunable.** The AEAD, the HMAC and the HKDF all take 32;
/// a configurable key length is a lever whose only use is to make a key
/// weaker.
pub type RootKey = Key32;

/// One of ADR-0043 §3's three shapes, parsed from configuration at startup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeySource {
    /// `file:///path`. The default.
    File(PathBuf),
    /// `command:///path`. Run it; read the key from its standard output.
    Command(PathBuf),
    /// `env://NAME`. Supported, discouraged.
    Env(String),
}

impl KeySource {
    /// Parse a provider URL. **Anything that is not one of the three shapes
    /// is refused rather than guessed at** — a bare path silently treated as
    /// `file://` would make a typo in a scheme into a different key source.
    pub fn parse(spec: &str) -> Result<Self, KeyError> {
        let spec = spec.trim();
        if let Some(rest) = spec.strip_prefix("file://") {
            if rest.is_empty() {
                return Err(KeyError::UnparseableSource);
            }
            Ok(Self::File(PathBuf::from(rest)))
        } else if let Some(rest) = spec.strip_prefix("command://") {
            if rest.is_empty() {
                return Err(KeyError::UnparseableSource);
            }
            Ok(Self::Command(PathBuf::from(rest)))
        } else if let Some(rest) = spec.strip_prefix("env://") {
            if rest.is_empty() {
                return Err(KeyError::UnparseableSource);
            }
            Ok(Self::Env(rest.to_string()))
        } else {
            Err(KeyError::UnparseableSource)
        }
    }

    /// What an operator may see in a log line: the shape and, for a file, the
    /// path. **Never the key, and never an environment variable's value.**
    pub fn describe(&self) -> String {
        match self {
            Self::File(p) => format!("file://{}", p.display()),
            Self::Command(p) => format!("command://{}", p.display()),
            Self::Env(name) => format!("env://{name}"),
        }
    }

    /// Load the key.
    ///
    /// `create_if_missing` applies to `file://` only, and is ADR-0043 §1's
    /// *"generated at first start"*: the file is created with 32 bytes from
    /// the OS CSPRNG, mode 0400, owned by whoever the process runs as. It is
    /// never created for `command://` (the operator's program owns that key)
    /// or for `env://` (there is nothing to create).
    pub fn load(&self, create_if_missing: bool) -> Result<RootKey, KeyError> {
        match self {
            Self::File(path) => load_file(path, create_if_missing),
            Self::Command(path) => load_command(path),
            Self::Env(name) => {
                let value = std::env::var(name).map_err(|_| KeyError::EnvUnset)?;
                decode(value.as_bytes())
            }
        }
    }
}

/// Why a key could not be loaded.
///
/// **No variant carries the key, the candidate bytes, or an environment
/// variable's value.** A key that appears in an error message appears in a
/// log, and a log is the thing least likely to be encrypted.
#[derive(Debug, PartialEq, Eq)]
pub enum KeyError {
    /// Not one of `file://`, `command://`, `env://`.
    UnparseableSource,
    /// The file named does not exist, and creating it was not asked for.
    Missing,
    /// The file exists but could not be read.
    Unreadable,
    /// The file could be read by more than its owner. ADR-0043 §1 says mode
    /// 0400; a key file the database role — or any other account on the host
    /// — can read is the one thing this whole design is about.
    TooPermissive { mode: u32 },
    /// The file could not be created, or could not be created with the mode
    /// this module insists on.
    Uncreatable,
    /// `env://NAME` and `NAME` is not set.
    EnvUnset,
    /// The program could not be run at all.
    CommandFailedToStart,
    /// The program ran and exited non-zero, or wrote nothing.
    CommandFailed,
    /// The program did not finish inside [`COMMAND_TIMEOUT`] and was killed.
    /// **A startup that hangs forever is worse than one that fails**: the
    /// orchestrator's own restart and alerting never fire.
    CommandTimedOut,
    /// The program wrote more than [`COMMAND_OUTPUT_LIMIT`] bytes. A key is
    /// 32 bytes or 64 hex characters; this is not a key.
    CommandOutputTooLarge,
    /// What arrived was not 32 raw bytes and not 64 hex characters.
    NotAKey,
    /// The OS CSPRNG refused. There is no fallback and there must not be one.
    NoRandomness,
    /// **The master key and the chain master are the same 32 bytes.** §6's B5
    /// fix says they are different keys; one key in both places collapses
    /// that separation and nothing downstream would ever notice.
    RootsIdentical,
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnparseableSource => f.write_str(
                "a key source must be file:///path, command:///path or env://NAME (ADR-0043 §3)",
            ),
            Self::Missing => f.write_str("the key file named does not exist"),
            Self::Unreadable => f.write_str("the key file exists but could not be read"),
            Self::TooPermissive { mode } => write!(
                f,
                "the key file is mode {mode:04o}; it must be readable by its owner only (0400). \
                 ADR-0043 §1: a key the database role can read is not a key boundary."
            ),
            Self::Uncreatable => f.write_str(
                "the key file does not exist and could not be created with mode 0400. Its \
                 directory must exist and be writable by the user this server runs as.",
            ),
            Self::EnvUnset => f.write_str("the environment variable naming the key is not set"),
            Self::CommandFailedToStart => f.write_str("the key command could not be run"),
            Self::CommandFailed => {
                f.write_str("the key command exited non-zero or produced no key")
            }
            Self::CommandTimedOut => write!(
                f,
                "the key command did not finish within {} seconds and was killed. Nothing was \
                 read from it. A key command that blocks -- an unreachable KMS endpoint, a \
                 prompt on a terminal that is not there -- would otherwise hold startup open \
                 forever.",
                COMMAND_TIMEOUT.as_secs()
            ),
            Self::CommandOutputTooLarge => write!(
                f,
                "the key command wrote more than {COMMAND_OUTPUT_LIMIT} bytes. A key is \
                 {KEY_LEN} raw bytes or {} hexadecimal characters; whatever that program is \
                 printing, it is not a key.",
                KEY_LEN * 2
            ),
            Self::NotAKey => write!(
                f,
                "a key must be exactly {KEY_LEN} raw bytes or {} hexadecimal characters. It is \
                 not padded, hashed or truncated to fit -- a wrong file must fail, not work.",
                KEY_LEN * 2
            ),
            Self::NoRandomness => f.write_str("the operating system's random generator refused"),
            Self::RootsIdentical => f.write_str(
                "the master key and the chain key are the same 32 bytes. They are deliberately \
                 different keys (`docs/PHASE-2-STORAGE-DESIGN.md` §6's B5 fix): the chain key \
                 is what an operator hands someone to verify a history, and it must not also \
                 open the designs. Check whether both settings name the same file or the same \
                 value.",
            ),
        }
    }
}

impl std::error::Error for KeyError {}

/// 32 raw bytes, or 64 hex characters with optional surrounding whitespace.
///
/// Two encodings and no more: raw is what `head -c 32 /dev/urandom` writes,
/// hex is what an operator can paste into a ticket without a base64 mistake.
/// Anything else is [`KeyError::NotAKey`].
fn decode(raw: &[u8]) -> Result<RootKey, KeyError> {
    if raw.len() == KEY_LEN {
        let mut out = [0u8; KEY_LEN];
        out.copy_from_slice(raw);
        return Ok(RootKey::from_bytes(out));
    }

    // **One trailing line ending, stripped before anything else is tried.**
    // `head -c 32 /dev/urandom > k; echo >> k` and every editor that ends a
    // file with a newline produce 33 bytes. Trimming whitespace from both ends
    // handles that only while the key's own last byte is not itself
    // whitespace — and one byte in nine of a random key is (0x09, 0x0a, 0x0b,
    // 0x0c, 0x0d, 0x20 out of 256, plus the same at the front). A key file
    // that works for one random key and is rejected for the next is the worst
    // shape a loader can have: it looks like a bad file, not like a bug.
    let without_newline: &[u8] = raw
        .strip_suffix(b"\r\n")
        .or_else(|| raw.strip_suffix(b"\n"))
        .unwrap_or(raw);
    if without_newline.len() == KEY_LEN {
        let mut out = [0u8; KEY_LEN];
        out.copy_from_slice(without_newline);
        return Ok(RootKey::from_bytes(out));
    }

    let trimmed: &[u8] = {
        let mut start = 0;
        let mut end = raw.len();
        while start < end && raw[start].is_ascii_whitespace() {
            start += 1;
        }
        while end > start && raw[end - 1].is_ascii_whitespace() {
            end -= 1;
        }
        &raw[start..end]
    };
    if trimmed.len() == KEY_LEN {
        let mut out = [0u8; KEY_LEN];
        out.copy_from_slice(trimmed);
        return Ok(RootKey::from_bytes(out));
    }
    if trimmed.len() == KEY_LEN * 2 && trimmed.iter().all(u8::is_ascii_hexdigit) {
        let text = core::str::from_utf8(trimmed).map_err(|_| KeyError::NotAKey)?;
        let mut out = [0u8; KEY_LEN];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte =
                u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).map_err(|_| KeyError::NotAKey)?;
        }
        return Ok(RootKey::from_bytes(out));
    }
    Err(KeyError::NotAKey)
}

fn load_file(path: &Path, create_if_missing: bool) -> Result<RootKey, KeyError> {
    use std::os::unix::fs::PermissionsExt;

    match std::fs::metadata(path) {
        Ok(meta) => {
            // The low nine bits only: the file type and the setuid bits are
            // not what this check is about.
            let mode = meta.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                return Err(KeyError::TooPermissive { mode });
            }
            let bytes = std::fs::read(path).map_err(|_| KeyError::Unreadable)?;
            decode(&bytes)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && create_if_missing => {
            create_file(path)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(KeyError::Missing),
        Err(_) => Err(KeyError::Unreadable),
    }
}

/// ADR-0043 §1's *"generated at first start … mode 0400"*.
///
/// `create_new` is what makes this safe to call from more than one process:
/// it fails rather than truncating an existing key, so two servers starting
/// at once cannot leave one of them holding a key the other overwrote. The
/// loser re-reads the winner's file.
fn create_file(path: &Path) -> Result<RootKey, KeyError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut bytes = [0u8; KEY_LEN];
    getrandom::fill(&mut bytes).map_err(|_| KeyError::NoRandomness)?;

    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o400)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Someone else won the race. Read theirs.
            return load_file(path, false);
        }
        Err(_) => return Err(KeyError::Uncreatable),
    };
    file.write_all(&bytes).map_err(|_| KeyError::Uncreatable)?;
    file.sync_all().map_err(|_| KeyError::Uncreatable)?;
    Ok(RootKey::from_bytes(bytes))
}

/// How long a key command may take before it is killed.
///
/// **This is the load-bearing provider** — ADR-0043 §3 makes every KMS, Vault
/// and HSM integration a `command://` wrapper — so it is also the one that
/// talks to a network. A wrapper whose endpoint is unreachable blocks in
/// `read()` forever, and `std::process::Command::output()` has no timeout, so
/// the server never reaches its listener and never logs why. Ten seconds is
/// far above a local `cat` or a signed KMS call and far below a startup an
/// orchestrator will wait through.
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// How much of a key command's standard output is read.
///
/// A key is 32 bytes or 64 hex characters. Anything past this is not a key
/// being mis-formatted, it is a program streaming, and reading it unbounded
/// puts an attacker-or-accident-controlled length into this process's memory.
const COMMAND_OUTPUT_LIMIT: usize = 4096;

fn load_command(path: &Path) -> Result<RootKey, KeyError> {
    load_command_within(path, COMMAND_TIMEOUT, COMMAND_OUTPUT_LIMIT)
}

/// The body of [`load_command`], with the two bounds as parameters so a test
/// can drive them without waiting [`COMMAND_TIMEOUT`] of real seconds.
fn load_command_within(
    path: &Path,
    timeout: std::time::Duration,
    limit: usize,
) -> Result<RootKey, KeyError> {
    use std::io::Read;

    // Inherited stderr, captured stdout: the operator's wrapper may need to
    // say why it failed, and that belongs in the server's own error stream
    // rather than being swallowed. No shell: the path is executed directly,
    // so nothing in it is word-split or expanded.
    let mut child = std::process::Command::new(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| KeyError::CommandFailedToStart)?;

    // The read runs on its own thread because a bounded read is not a
    // non-blocking one: a program that writes nothing leaves `read` parked,
    // and the only way to get out of that without a new crate is to have
    // something else holding the clock. One byte past the limit is read
    // deliberately, so "exactly the limit" and "more than the limit" are
    // distinguishable.
    let mut stdout = child.stdout.take().expect("stdout was piped");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.by_ref().take(limit as u64 + 1).read_to_end(&mut buf);
        buf
    });

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => return Err(KeyError::CommandFailed),
        }
        if std::time::Instant::now() >= deadline {
            // Killed rather than left running: a wrapper holding a key open
            // is exactly the process not to leak.
            let _ = child.kill();
            let _ = child.wait();
            // **The reader is deliberately NOT joined here.** Killing
            // `/bin/sh` does not kill what it started, and a grandchild that
            // inherited this pipe keeps it open -- so joining would wait for
            // the very hang the timeout exists to end. The thread finishes
            // when the last writer closes the pipe; nothing downstream reads
            // what it collected.
            drop(reader);
            return Err(KeyError::CommandTimedOut);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };

    let stdout = reader.join().map_err(|_| KeyError::CommandFailed)?;
    // **The bound is checked before the exit status.** A program cut off at
    // the limit usually then dies on a closed pipe, and reporting that as
    // "exited non-zero" would send an operator to debug the wrong thing.
    if stdout.len() > limit {
        return Err(KeyError::CommandOutputTooLarge);
    }
    if !status.success() || stdout.is_empty() {
        return Err(KeyError::CommandFailed);
    }
    decode(&stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The key id, the wipe on drop and the `Debug` that prints neither are
    // `crypto::Key32`'s and are tested there. What is this module's own is
    // where the 32 bytes come from and what it refuses.

    #[test]
    fn the_three_shapes_parse_and_nothing_else_does() {
        assert_eq!(
            KeySource::parse("file:///var/lib/fathom/keys/master.key"),
            Ok(KeySource::File(PathBuf::from(
                "/var/lib/fathom/keys/master.key"
            )))
        );
        assert_eq!(
            KeySource::parse("command:///usr/local/bin/fathom-key"),
            Ok(KeySource::Command(PathBuf::from(
                "/usr/local/bin/fathom-key"
            )))
        );
        assert_eq!(
            KeySource::parse("env://FATHOM_MASTER_KEY_VALUE"),
            Ok(KeySource::Env("FATHOM_MASTER_KEY_VALUE".to_string()))
        );

        // A bare path is NOT quietly a file:// — see `KeySource::parse`.
        assert_eq!(
            KeySource::parse("/var/lib/fathom/keys/master.key"),
            Err(KeyError::UnparseableSource)
        );
        assert_eq!(
            KeySource::parse("file://"),
            Err(KeyError::UnparseableSource)
        );
        assert_eq!(
            KeySource::parse("vault://secret/fathom"),
            Err(KeyError::UnparseableSource)
        );
    }

    #[test]
    fn a_key_is_thirty_two_bytes_raw_or_sixty_four_hex_and_never_stretched_to_fit() {
        let raw = [7u8; KEY_LEN];
        assert_eq!(decode(&raw).unwrap().expose(), &raw);

        let hex = "07".repeat(KEY_LEN);
        assert_eq!(decode(hex.as_bytes()).unwrap().expose(), &raw);
        assert_eq!(
            decode(format!("{hex}\n").as_bytes()).unwrap().expose(),
            &raw
        );

        // Upper case hex is still hex.
        assert_eq!(
            decode(hex.to_ascii_uppercase().as_bytes())
                .unwrap()
                .expose(),
            &raw
        );

        // Too short, too long, and not-hex are all refusals. A passphrase is
        // not a key: nothing here hashes it into one, because then a wrong
        // file would silently work.
        assert_eq!(decode(b"short").unwrap_err(), KeyError::NotAKey);
        assert_eq!(decode(&[0u8; 31]).unwrap_err(), KeyError::NotAKey);
        assert_eq!(decode(&[0u8; 33]).unwrap_err(), KeyError::NotAKey);
        assert_eq!(
            decode("z".repeat(64).as_bytes()).unwrap_err(),
            KeyError::NotAKey
        );
    }

    #[test]
    fn a_file_key_round_trips_and_a_group_readable_one_is_refused() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("fathom-keytest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("master.key");

        // Created on first load, and the SECOND load gets the same key back
        // rather than a fresh one — a provider that regenerated silently
        // would destroy every design ever written.
        let source = KeySource::File(path.clone());
        let first = source.load(true).expect("create");
        let second = source.load(true).expect("read back");
        assert_eq!(first.expose(), second.expose());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o400
        );

        // Missing and not asked to create: a refusal, never a fresh key.
        let absent = KeySource::File(dir.join("nothing-here.key"));
        assert_eq!(absent.load(false).unwrap_err(), KeyError::Missing);

        // Group-readable: refused, with the mode in the message.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o440)).unwrap();
        assert_eq!(
            source.load(false).unwrap_err(),
            KeyError::TooPermissive { mode: 0o440 }
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_command_key_is_read_from_standard_output_and_a_failing_command_is_not_a_key() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("fathom-cmdtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");

        let hex = "ab".repeat(KEY_LEN);
        let good = dir.join("good.sh");
        let mut f = std::fs::File::create(&good).unwrap();
        writeln!(f, "#!/bin/sh\nprintf '%s' {hex}").unwrap();
        drop(f);
        std::fs::set_permissions(&good, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            KeySource::Command(good).load(false).unwrap().expose(),
            &[0xabu8; KEY_LEN]
        );

        let bad = dir.join("bad.sh");
        let mut f = std::fs::File::create(&bad).unwrap();
        writeln!(f, "#!/bin/sh\nexit 3").unwrap();
        drop(f);
        std::fs::set_permissions(&bad, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            KeySource::Command(bad).load(false).unwrap_err(),
            KeyError::CommandFailed
        );

        assert_eq!(
            KeySource::Command(dir.join("not-there"))
                .load(false)
                .unwrap_err(),
            KeyError::CommandFailedToStart
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unset_environment_variable_is_an_error_and_not_an_empty_key() {
        // A name nothing sets. Not set here either: mutating the process
        // environment is global and racy across parallel tests.
        assert_eq!(
            KeySource::Env("FATHOM_A_VARIABLE_NOTHING_SETS".to_string())
                .load(false)
                .unwrap_err(),
            KeyError::EnvUnset
        );
    }

    #[test]
    fn describing_a_source_never_prints_a_value() {
        assert_eq!(
            KeySource::Env("SOME_NAME".into()).describe(),
            "env://SOME_NAME"
        );
        assert_eq!(
            KeySource::File(PathBuf::from("/k/master.key")).describe(),
            "file:///k/master.key"
        );
    }

    #[test]
    fn a_trailing_newline_is_stripped_even_when_the_key_ends_in_whitespace() {
        // `head -c 32 /dev/urandom > k; echo >> k`, and the key's last byte is
        // 0x0a. Trimming whitespace from both ends eats the key's own byte and
        // leaves 31, so the file is refused -- for one key in nine, and not
        // for the next one, which is the worst way for a loader to fail.
        let mut key = [7u8; KEY_LEN];
        key[KEY_LEN - 1] = b'\n';
        let mut file = key.to_vec();
        file.push(b'\n');
        assert_eq!(decode(&file).unwrap().expose(), &key);

        // The same at the front, where the trim is just as greedy.
        let mut key = [7u8; KEY_LEN];
        key[0] = b' ';
        let mut file = key.to_vec();
        file.push(b'\n');
        assert_eq!(decode(&file).unwrap().expose(), &key);

        // CRLF too, because a key file can arrive from a Windows editor.
        let key = [7u8; KEY_LEN];
        let mut file = key.to_vec();
        file.extend_from_slice(b"\r\n");
        assert_eq!(decode(&file).unwrap().expose(), &key);

        // And none of this loosens what a key is: 30 bytes and a newline is
        // still not a key, and never becomes one by padding.
        let mut short = vec![7u8; KEY_LEN - 2];
        short.push(b'\n');
        assert_eq!(decode(&short).unwrap_err(), KeyError::NotAKey);
    }

    #[test]
    fn a_key_command_that_never_finishes_is_killed_rather_than_holding_startup_open() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("fathom-hangtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");

        // A wrapper whose KMS endpoint is unreachable, in one line.
        let hangs = dir.join("hangs.sh");
        let mut f = std::fs::File::create(&hangs).unwrap();
        writeln!(f, "#!/bin/sh\nsleep 60").unwrap();
        drop(f);
        std::fs::set_permissions(&hangs, std::fs::Permissions::from_mode(0o700)).unwrap();

        let started = std::time::Instant::now();
        assert_eq!(
            load_command_within(&hangs, std::time::Duration::from_millis(200), 4096).unwrap_err(),
            KeyError::CommandTimedOut
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the load did not give up"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_key_command_that_streams_is_bounded_rather_than_read_whole() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("fathom-streamtest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");

        let streams = dir.join("streams.sh");
        let mut f = std::fs::File::create(&streams).unwrap();
        // Far more than any key, and nothing this process should hold.
        writeln!(f, "#!/bin/sh\nyes AAAAAAAAAAAAAAAA | head -c 200000").unwrap();
        drop(f);
        std::fs::set_permissions(&streams, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(
            load_command_within(&streams, std::time::Duration::from_secs(5), 4096).unwrap_err(),
            KeyError::CommandOutputTooLarge
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
