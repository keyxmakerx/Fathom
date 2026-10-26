//! The three backup subcommands — ADR-0070. `backup.rs` holds the formats;
//! this holds what an operator types.
//!
//! - `fathom-server backup [--firmware DIR] < dump > file.fdata` seals a
//!   `pg_dump -Fc` stream from standard input, plus the staged firmware, into a
//!   data file on standard output.
//! - `fathom-server keys-file [--keys-dir DIR] > file.fkeys` seals the key
//!   volume under a fresh recovery phrase, which goes to standard error once.
//! - `fathom-server restore FILE.fdata --keys FILE.fkeys (--out DIR | --check)`
//!   checks the keys file against the data file's label, then writes the dump,
//!   the firmware and the keys under `DIR`, or only proves they all open.
//!
//! None of them needs the database or the full configuration: `pg_dump` and
//! `pg_restore` do the database's part, from the `db` container in a compose
//! deployment, because the server image is distroless and has neither.

use std::io::{self, BufRead, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use crate::backup::{
    self, BackupError, DataReader, DataWriter, Item, KeysFile, Label, DUMP_NAME, FIRMWARE_PREFIX,
};
use crate::config::{DEFAULT_CHAIN_KEY, DEFAULT_MASTER_KEY};
use crate::crypto::Key32;
use crate::keyprovider::KeySource;

/// `FATHOM_BACKUP_KEY`'s default: beside the master key, in the key volume.
pub const DEFAULT_BACKUP_KEY: &str = "file:///var/lib/fathom/keys/backup.key";
/// `FATHOM_VAULT_KEY`'s default. Absent until ADR-0042's vault is built.
pub const DEFAULT_VAULT_KEY: &str = "file:///var/lib/fathom/keys/vault.key";
/// The key volume, for `keys-file`.
pub const DEFAULT_KEYS_DIR: &str = "/var/lib/fathom/keys";

/// A wrong-keys refusal exits like the server's own wrong-key refusal.
const EXIT_WRONG_KEYS: u8 = 11;

fn source(var: &str, default: &str) -> Result<KeySource, String> {
    let spec = std::env::var(var)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| default.to_string());
    KeySource::parse(&spec).map_err(|e| format!("{var}: {e}"))
}

fn fail(msg: impl std::fmt::Display) -> ExitCode {
    eprintln!("fathom-server: {msg}");
    ExitCode::FAILURE
}

fn usage(msg: &str) -> ExitCode {
    eprintln!("fathom-server: {msg}");
    ExitCode::from(2)
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

/// The backup key, created on first use for a `file://` source. In a compose
/// deployment `keys-init` makes it, because the server mounts the key volume
/// read-only.
fn backup_key() -> Result<Key32, String> {
    let src = source("FATHOM_BACKUP_KEY", DEFAULT_BACKUP_KEY)?;
    src.load(true)
        .map_err(|e| format!("the backup key ({}): {e}", src.describe()))
}

/// A root key's id for the label, or nothing. A key that cannot be read here
/// does not stop a backup: the label just cannot vouch for it.
fn optional_key(var: &str, default: &str, warn: bool) -> Option<Key32> {
    let src = source(var, default).ok()?;
    match src.load(false) {
        Ok(k) => Some(k),
        Err(e) => {
            if warn {
                eprintln!(
                    "fathom-server: note: {} could not be read ({e}); the backup will not record its id",
                    src.describe()
                );
            }
            None
        }
    }
}

/// The ids of the keys this install holds now, for the Backups panel to
/// compare a keys file's record against. The master and chain ids come from
/// the running server's ring; the backup and vault keys are read here and
/// silently left out when absent.
pub fn current_ids(master: crate::crypto::KeyId, chain: crate::crypto::KeyId) -> Label {
    Label {
        made_at_unix: 0,
        fathom_version: env!("CARGO_PKG_VERSION").to_string(),
        backup_key: optional_key("FATHOM_BACKUP_KEY", DEFAULT_BACKUP_KEY, false).map(|k| k.id()),
        master_key: Some(master),
        chain_key: Some(chain),
        vault_key: optional_key("FATHOM_VAULT_KEY", DEFAULT_VAULT_KEY, false).map(|k| k.id()),
    }
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

pub fn backup(args: &[String]) -> ExitCode {
    let firmware = flag(args, "--firmware").or_else(|| {
        std::env::var("FATHOM_FIRMWARE_DIR")
            .ok()
            .filter(|s| !s.trim().is_empty())
    });
    let stdin = io::stdin();
    if stdin.is_terminal() {
        return usage(
            "backup reads a database dump on standard input; pipe `pg_dump -Fc` into it \
             (docs/OPERATING.md, Backups)",
        );
    }
    let stdout = io::stdout();
    if stdout.is_terminal() {
        return usage("backup writes the data file to standard output; redirect it to a file");
    }
    let key = match backup_key() {
        Ok(k) => k,
        Err(e) => return fail(e),
    };
    let master = optional_key("FATHOM_MASTER_KEY", DEFAULT_MASTER_KEY, true);
    let chain = optional_key("FATHOM_CHAIN_KEY", DEFAULT_CHAIN_KEY, true);
    let vault = optional_key("FATHOM_VAULT_KEY", DEFAULT_VAULT_KEY, false);
    let label = backup::label_now(&key, master.as_ref(), chain.as_ref(), vault.as_ref());

    match write_backup(
        stdin.lock(),
        stdout.lock(),
        &key,
        &label,
        firmware.as_deref().map(Path::new),
    ) {
        Ok((dump, files, fw_bytes)) => {
            eprintln!(
                "fathom-server: backup sealed: database dump {} bytes, {files} firmware file(s) {fw_bytes} bytes",
                dump
            );
            eprintln!(
                "fathom-server: it needs the keys file holding {}",
                describe(&label)
            );
            ExitCode::SUCCESS
        }
        Err(e) => fail(format!(
            "the backup was not finished, and the partial file must not be kept: {e}"
        )),
    }
}

/// Seal a dump and a firmware folder. Returns the dump's size, the firmware
/// file count and their total size.
pub fn write_backup(
    mut dump: impl Read,
    out: impl Write,
    key: &Key32,
    label: &Label,
    firmware: Option<&Path>,
) -> Result<(u64, u64, u64), BackupError> {
    // `pg_dump -Fc`'s archive starts with these five bytes; anything else is
    // not a dump `pg_restore` will take, and finding out at restore is too late.
    let mut magic = [0u8; 5];
    dump.read_exact(&mut magic).map_err(|_| {
        BackupError::NotADump("standard input was empty: pipe `pg_dump -Fc` into backup")
    })?;
    if &magic != b"PGDMP" {
        return Err(BackupError::NotADump(
            "standard input is not a custom-format dump: run pg_dump with -Fc",
        ));
    }
    let mut w = DataWriter::new(out, key, label)?;
    w.begin_file(DUMP_NAME)?;
    w.write_bytes(&magic)?;
    let dump_len = 5 + w.copy_from(dump)?;
    w.end_file()?;

    let (mut count, mut bytes) = (0u64, 0u64);
    if let Some(dir) = firmware {
        if dir.is_dir() {
            let mut files = Vec::new();
            walk(dir, dir, &mut files)?;
            files.sort();
            for (rel, path) in files {
                w.begin_file(&format!("{FIRMWARE_PREFIX}{rel}"))?;
                bytes += w.copy_from(std::fs::File::open(&path)?)?;
                w.end_file()?;
                count += 1;
            }
        }
    }
    w.finish()?;
    Ok((dump_len, count, bytes))
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let path = entry.path();
        if ft.is_dir() {
            walk(root, &path, out)?;
        } else if ft.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(io::Error::other)?
                .to_string_lossy()
                .replace('\\', "/");
            out.push((rel, path));
        }
    }
    Ok(())
}

fn describe(l: &Label) -> String {
    let id = |what: &str, k: &Option<crate::crypto::KeyId>| k.map(|k| format!("{what} key {k}"));
    [
        id("backup", &l.backup_key),
        id("master", &l.master_key),
        id("chain", &l.chain_key),
        id("vault", &l.vault_key),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ")
}

// ---------------------------------------------------------------------------
// keys-file
// ---------------------------------------------------------------------------

pub fn keys_file(args: &[String]) -> ExitCode {
    let dir =
        PathBuf::from(flag(args, "--keys-dir").unwrap_or_else(|| DEFAULT_KEYS_DIR.to_string()));
    let stdout = io::stdout();
    if stdout.is_terminal() {
        return usage("keys-file writes the keys file to standard output; redirect it to a file");
    }
    // Make sure there is a backup key to carry. In compose it already exists.
    if let Err(e) = backup_key() {
        return fail(e);
    }
    let kf = match KeysFile::from_dir(&dir) {
        Ok(k) => k,
        Err(e) => {
            return fail(format!(
                "could not read the key volume at {}: {e}",
                dir.display()
            ))
        }
    };
    if kf.label.backup_key.is_none() {
        return fail(format!(
            "there is no backup.key in {}; set FATHOM_BACKUP_KEY to a file:// path inside it, or pass --keys-dir",
            dir.display()
        ));
    }
    let phrase = match backup::new_phrase() {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let raw = match backup::parse_phrase(&phrase) {
        Ok(r) => r,
        Err(e) => return fail(e),
    };
    let sealed = match kf.seal(&raw) {
        Ok(s) => s,
        Err(e) => return fail(e),
    };
    if let Err(e) = stdout
        .lock()
        .write_all(&sealed)
        .and_then(|()| io::stdout().flush())
    {
        return fail(format!("could not write the keys file: {e}"));
    }
    // `--record FILE`: the key ids this keys file holds, so the Backups screen
    // can say when a key has changed since (the nightly service passes it).
    if let Some(record) = flag(args, "--record") {
        if let Err(e) = std::fs::write(&record, kf.label.to_text()) {
            eprintln!("fathom-server: note: the keys file was written, but {record} was not: {e}");
        }
    }
    let names: Vec<&str> = kf.files.iter().map(|(n, _)| n.as_str()).collect();
    eprintln!();
    eprintln!("  Recovery phrase for this keys file. It is shown once and not kept anywhere:");
    eprintln!();
    eprintln!("      {phrase}");
    eprintln!();
    eprintln!("  Put it in your password manager or print it. Store the keys file away from");
    eprintln!("  the data files: neither opens anything without the other and this phrase.");
    eprintln!("  It holds: {}", names.join(", "));
    eprintln!("  Key ids: {}", describe(&kf.label));
    eprintln!();
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// dump-from: the nightly service's restore test
// ---------------------------------------------------------------------------

/// `fathom-server dump-from FILE.fdata`: the database dump, to standard
/// output, opened with the backup key this install holds. No keys file and no
/// phrase, so it can run unattended; a chunk that fails stops it with a
/// non-zero exit, which the caller's pipeline must check.
pub fn dump_from(args: &[String]) -> ExitCode {
    let Some(path) = args.first().filter(|a| !a.starts_with("--")) else {
        return usage("dump-from takes a data file: dump-from FILE.fdata > database.dump");
    };
    if io::stdout().is_terminal() {
        return usage("dump-from writes the dump to standard output; pipe it to pg_restore");
    }
    let key = match backup_key() {
        Ok(k) => k,
        Err(e) => return fail(e),
    };
    let file = match std::fs::File::open(path) {
        Ok(f) => io::BufReader::new(f),
        Err(e) => return fail(format!("{path}: {e}")),
    };
    let reader = match DataReader::open(file) {
        Ok(r) => r,
        Err(e) => return fail(format!("{path}: {e}")),
    };
    if reader.label().backup_key != Some(key.id()) {
        eprintln!(
            "fathom-server: {path} was made under another backup key; this install's cannot open it"
        );
        return ExitCode::from(EXIT_WRONG_KEYS);
    }
    let mut contents = reader.unlock(&key);
    let mut out = io::stdout().lock();
    let mut in_dump = false;
    let mut saw_dump = false;
    loop {
        match contents.next() {
            Ok(None) => break,
            Ok(Some(Item::FileStart(name))) => {
                in_dump = name == DUMP_NAME;
                saw_dump |= in_dump;
            }
            Ok(Some(Item::Bytes(b))) => {
                if in_dump {
                    if let Err(e) = out.write_all(&b) {
                        return fail(format!("could not write the dump: {e}"));
                    }
                }
            }
            Ok(Some(Item::FileEnd)) => in_dump = false,
            Err(e) => return fail(format!("{path}: {e}")),
        }
    }
    if let Err(e) = out.flush() {
        return fail(format!("could not write the dump: {e}"));
    }
    if !saw_dump {
        return fail(format!("{path}: there is no database dump in it"));
    }
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

fn read_phrase() -> Result<[u8; backup::PHRASE_BYTES], String> {
    let text = match std::env::var("FATHOM_RECOVERY_PHRASE") {
        Ok(p) if !p.trim().is_empty() => p,
        _ => {
            if io::stdin().is_terminal() {
                eprint!("Recovery phrase for the keys file: ");
                let _ = io::stderr().flush();
            }
            let mut line = String::new();
            io::stdin()
                .lock()
                .read_line(&mut line)
                .map_err(|e| format!("could not read the recovery phrase: {e}"))?;
            line
        }
    };
    backup::parse_phrase(&text).map_err(|e| e.to_string())
}

pub fn restore(args: &[String]) -> ExitCode {
    let Some(data_path) = args.first().filter(|a| !a.starts_with("--")) else {
        return usage("restore takes the data file first: restore FILE.fdata --keys FILE.fkeys (--out DIR | --check)");
    };
    let Some(keys_path) = flag(args, "--keys") else {
        return usage("restore needs --keys FILE.fkeys, the keys file made for this install");
    };
    let check = args.iter().any(|a| a == "--check");
    let out = flag(args, "--out").map(PathBuf::from);
    if check == out.is_some() {
        return usage("restore takes exactly one of --out DIR (write the files) or --check (only prove they open)");
    }
    if let Some(dir) = &out {
        if dir.exists()
            && std::fs::read_dir(dir)
                .map(|mut d| d.next().is_some())
                .unwrap_or(true)
        {
            return usage("--out must name a folder that does not exist yet, or an empty one");
        }
    }

    let data = match std::fs::File::open(data_path) {
        Ok(f) => io::BufReader::new(f),
        Err(e) => return fail(format!("{data_path}: {e}")),
    };
    let reader = match DataReader::open(data) {
        Ok(r) => r,
        Err(e) => return fail(format!("{data_path}: {e}")),
    };
    let keys_bytes = match std::fs::read(&keys_path) {
        Ok(b) => b,
        Err(e) => return fail(format!("{keys_path}: {e}")),
    };
    // The label first, before the phrase is asked for: a keys file that cannot
    // possibly fit is named without anyone typing anything.
    let keys_label = match KeysFile::peek_label(&keys_bytes) {
        Ok(l) => l,
        Err(e) => return fail(format!("{keys_path}: {e}")),
    };
    if reader.label().backup_key != keys_label.backup_key {
        let probe = KeysFile {
            label: keys_label,
            files: Vec::new(),
        };
        if let Err(e) = backup::match_keys(reader.label(), &probe) {
            eprintln!("fathom-server: {e}");
            return ExitCode::from(EXIT_WRONG_KEYS);
        }
    }
    let phrase = match read_phrase() {
        Ok(p) => p,
        Err(e) => return fail(e),
    };
    let keys = match KeysFile::open(&keys_bytes, &phrase) {
        Ok(k) => k,
        Err(e) => return fail(format!("{keys_path}: {e}")),
    };
    let label = reader.label().clone();
    let bkey = match backup::match_keys(&label, &keys) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("fathom-server: {e}");
            return ExitCode::from(EXIT_WRONG_KEYS);
        }
    };
    for note in backup::keys_held_elsewhere(&label, &keys) {
        eprintln!("fathom-server: note: {note}");
    }

    let result = match &out {
        Some(dir) => write_restore(reader, &bkey, &keys, dir),
        None => check_restore(reader, &bkey),
    };
    match result {
        Ok((files, bytes)) => {
            eprintln!(
                "fathom-server: the backup made {} opens with this keys file: {files} file(s), {bytes} bytes, every chunk verified",
                backup::date(label.made_at_unix)
            );
            if let Some(dir) = out {
                print_next_steps(&dir);
            }
            ExitCode::SUCCESS
        }
        Err(e) => fail(e),
    }
}

/// Decrypt everything and keep nothing: the restore test.
pub fn check_restore<R: Read>(
    reader: DataReader<R>,
    key: &Key32,
) -> Result<(u64, u64), BackupError> {
    let mut contents = reader.unlock(key);
    let (mut files, mut bytes, mut saw_dump) = (0u64, 0u64, false);
    while let Some(item) = contents.next()? {
        match item {
            Item::FileStart(name) => {
                files += 1;
                saw_dump |= name == DUMP_NAME;
            }
            Item::Bytes(b) => bytes += b.len() as u64,
            Item::FileEnd => {}
        }
    }
    if !saw_dump {
        return Err(BackupError::NotABackup("backup with a database dump in it"));
    }
    Ok((files, bytes))
}

fn write_restore<R: Read>(
    reader: DataReader<R>,
    key: &Key32,
    keys: &KeysFile,
    dir: &Path,
) -> Result<(u64, u64), BackupError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let data_dir = dir.join("data");
    std::fs::create_dir_all(&data_dir)?;
    let mut contents = reader.unlock(key);
    let (mut files, mut bytes) = (0u64, 0u64);
    let mut current: Option<std::fs::File> = None;
    while let Some(item) = contents.next()? {
        match item {
            Item::FileStart(name) => {
                let rel = backup::safe_relative(&name)?;
                let path = data_dir.join(rel);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                current = Some(
                    std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o600)
                        .open(&path)?,
                );
                files += 1;
            }
            Item::Bytes(b) => {
                let f = current.as_mut().ok_or(BackupError::Damaged)?;
                f.write_all(&b)?;
                bytes += b.len() as u64;
            }
            Item::FileEnd => {
                let f = current.take().ok_or(BackupError::Damaged)?;
                f.sync_all()?;
            }
        }
    }

    // The key volume's files, at the modes keys-init gives them.
    let keys_dir = dir.join("keys");
    std::fs::create_dir_all(&keys_dir)?;
    std::fs::set_permissions(&keys_dir, std::fs::Permissions::from_mode(0o700))?;
    for (name, body) in &keys.files {
        let rel = backup::safe_relative(name)?;
        let mode = if name.ends_with(".pw") { 0o444 } else { 0o400 };
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(keys_dir.join(rel))?;
        f.write_all(body)?;
        f.sync_all()?;
    }
    Ok((files, bytes))
}

fn print_next_steps(dir: &Path) {
    let d = dir.display();
    eprintln!();
    eprintln!("  Restored into {d}:");
    eprintln!("    {d}/data/{DUMP_NAME}   the database, for pg_restore");
    eprintln!("    {d}/data/firmware/      staged firmware images, if there were any");
    eprintln!("    {d}/keys/               the key volume's files");
    eprintln!();
    eprintln!("  Next: put the keys back in the key volume, restore the database into an empty");
    eprintln!("  one, then start the server. docs/OPERATING.md, \"Restore\", has the commands.");
    eprintln!("  The server checks the keys against the database at start and refuses a mismatch.");
    eprintln!();
}
