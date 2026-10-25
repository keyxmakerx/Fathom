//! Backing up an install — ADR-0070.
//!
//! **Two files, never one.** ADR-0043 §9's operator rule is *"never put
//! `master.key` and a database dump in the same archive"*, so a backup is:
//!
//! - a **data file** (`.fdata`): the `pg_dump` stream and the staged firmware
//!   images, sealed under a key derived from `backup.key`. The vault's rows are
//!   inside the dump like every other table (ADR-0042 §4.4 gives them their own
//!   schema, not their own database). Mode A secrets are already sealed in the
//!   browser before they reach PostgreSQL, so they travel still sealed and
//!   nothing here can open them.
//! - a **keys file** (`.fkeys`): every file in the key volume — `master.key`,
//!   `chain.key`, `backup.key`, `vault.key` once the vault exists, and the
//!   database role passwords — sealed under a recovery phrase that is shown
//!   once and never stored.
//!
//! Keys change rarely, so the keys file is made at install and again when a key
//! changes; the data file is made every night. Each carries a label of key ids
//! (non-secret, ADR-0043 §4) so a restore names the wrong file instead of
//! failing as though the backup were damaged.
//!
//! # The data file's payload
//!
//! Chunked AEAD in the shape of age's payload (C2SP `age.md`, "Payload", read
//! 2026-10-25): *"the first 11 bytes are a big endian chunk counter starting at
//! zero … the last byte is 0x01 for the final chunk and 0x00 for all preceding
//! ones"*, and *"Streaming decryption MUST signal an error if the end of file is
//! reached without successfully decrypting a final chunk."* A counter nonce is
//! safe here, where `crypto.rs` forbids one, because every file has its own key:
//! `HKDF-Expand(backup.key, label ‖ 32 random bytes)`. The header is bound into
//! every chunk's associated data, so a label cannot be swapped onto another
//! file's chunks.

use core::fmt;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::credentials::{ARGON2_M_COST, ARGON2_P_COST, ARGON2_T_COST};
use crate::crypto::{self, CryptoError, Key32, KeyId, KEY_LEN, NONCE_LEN, TAG_LEN};

/// The first eight bytes of a data file.
pub const DATA_MAGIC: &[u8; 8] = b"FATHOMBD";
/// The first eight bytes of a keys file.
pub const KEYS_MAGIC: &[u8; 8] = b"FATHOMBK";
/// Both formats' version. A reader refuses any other.
pub const FORMAT_VERSION: u16 = 1;

/// Plaintext bytes per chunk. 1 MiB keeps the chunk count of a multi-gigabyte
/// firmware image in the thousands, far inside an 88-bit counter.
pub const CHUNK_LEN: usize = 1 << 20;

/// The recovery phrase's entropy: 128 bits, the bound ADR-0043 §6 chose for the
/// vault key, written in the same 26 characters.
pub const PHRASE_BYTES: usize = 16;

const DATA_KEY_INFO: &[u8] = b"fathom/backup/data/v1";
const CHUNK_AAD_LABEL: &[u8] = b"fathom/backup/chunk/v1";
const SALT_LEN: usize = 32;
const KEYS_SALT_LEN: usize = 16;
/// The largest single file a keys file will carry. A key is 32 bytes and a
/// password 65; anything near this is not a key.
const KEYS_ENTRY_MAX: usize = 64 * 1024;

// Frames inside the decrypted data stream.
const FRAME_FILE: u8 = b'F';
const FRAME_BYTES: u8 = b'B';
const FRAME_END_FILE: u8 = b'E';
const FRAME_END: u8 = b'Z';

/// The data file's name for the database dump.
pub const DUMP_NAME: &str = "database.dump";
/// The prefix under which staged firmware images are stored.
pub const FIRMWARE_PREFIX: &str = "firmware/";

/// Why a backup could not be written or opened. **No variant carries key bytes
/// or the phrase.**
#[derive(Debug)]
pub enum BackupError {
    Io(io::Error),
    Crypto(CryptoError),
    /// Not one of our files, or a version this build does not read.
    NotABackup(&'static str),
    /// A chunk's tag did not verify: altered, reordered, or the wrong key.
    Damaged,
    /// The stream ended before its final chunk.
    Truncated,
    /// The label did not parse.
    BadLabel,
    /// Standard input was not a `pg_dump -Fc` archive.
    NotADump(&'static str),
    /// The recovery phrase is not 26 base32 characters.
    BadPhrase,
    /// The phrase did not open the keys file.
    WrongPhrase,
    /// A file name inside the backup tries to leave the restore folder.
    UnsafeName(String),
    /// The keys file does not belong with this data file. The string says which
    /// key, by id, in the operator's register.
    WrongKeys(String),
}

impl fmt::Display for BackupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "{e}"),
            Self::Crypto(e) => write!(f, "{e}"),
            Self::NotABackup(what) => write!(f, "this is not a Fathom {what}, or it was made by a newer version"),
            Self::Damaged => f.write_str(
                "the data file is damaged or was altered: a chunk did not verify. Nothing after it was used",
            ),
            Self::Truncated => f.write_str(
                "the data file ends early: its last chunk is missing. It was cut off while being written or copied",
            ),
            Self::BadLabel => f.write_str("the file's label is unreadable"),
            Self::NotADump(what) => f.write_str(what),
            Self::BadPhrase => f.write_str(
                "a recovery phrase is 26 letters and digits (dashes and spaces are ignored)",
            ),
            Self::WrongPhrase => f.write_str(
                "that recovery phrase does not open this keys file. Each keys file has its own phrase",
            ),
            Self::UnsafeName(n) => write!(f, "refused a file name inside the backup: {n:?}"),
            Self::WrongKeys(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for BackupError {}

impl From<io::Error> for BackupError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

impl From<CryptoError> for BackupError {
    fn from(e: CryptoError) -> Self {
        Self::Crypto(e)
    }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/// The key ids a backup was made under, plus when and by what. Written as plain
/// `name value` lines: authenticated, not secret.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Label {
    pub made_at_unix: u64,
    pub fathom_version: String,
    pub backup_key: Option<KeyId>,
    pub master_key: Option<KeyId>,
    pub chain_key: Option<KeyId>,
    pub vault_key: Option<KeyId>,
}

impl Label {
    fn encode(&self) -> Vec<u8> {
        let id = |k: &Option<KeyId>| k.map(|k| k.to_string()).unwrap_or_else(|| "-".into());
        format!(
            "made_at {}\nfathom {}\nbackup_key {}\nmaster_key {}\nchain_key {}\nvault_key {}\n",
            self.made_at_unix,
            self.fathom_version.replace(['\n', ' '], "_"),
            id(&self.backup_key),
            id(&self.master_key),
            id(&self.chain_key),
            id(&self.vault_key),
        )
        .into_bytes()
    }

    fn decode(bytes: &[u8]) -> Result<Self, BackupError> {
        let text = core::str::from_utf8(bytes).map_err(|_| BackupError::BadLabel)?;
        let mut out = Label::default();
        for line in text.lines() {
            let (name, value) = line.split_once(' ').ok_or(BackupError::BadLabel)?;
            let id = || -> Result<Option<KeyId>, BackupError> {
                if value == "-" {
                    Ok(None)
                } else {
                    KeyId::parse(value).map(Some).ok_or(BackupError::BadLabel)
                }
            };
            match name {
                "made_at" => out.made_at_unix = value.parse().map_err(|_| BackupError::BadLabel)?,
                "fathom" => out.fathom_version = value.to_string(),
                "backup_key" => out.backup_key = id()?,
                "master_key" => out.master_key = id()?,
                "chain_key" => out.chain_key = id()?,
                "vault_key" => out.vault_key = id()?,
                // A newer writer may add lines; they are authenticated, so
                // ignoring one cannot be used to smuggle anything.
                _ => {}
            }
        }
        Ok(out)
    }
}

/// `YYYY-MM-DD` in UTC, for messages. Howard Hinnant's `civil_from_days`
/// (chrono-compatible date algorithms, public domain), so no date crate.
pub fn date(unix: u64) -> String {
    let z = (unix / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A label for a backup made now, by this build.
pub fn label_now(
    backup_key: &Key32,
    master: Option<&Key32>,
    chain: Option<&Key32>,
    vault: Option<&Key32>,
) -> Label {
    Label {
        made_at_unix: now_unix(),
        fathom_version: env!("CARGO_PKG_VERSION").to_string(),
        backup_key: Some(backup_key.id()),
        master_key: master.map(Key32::id),
        chain_key: chain.map(Key32::id),
        vault_key: vault.map(Key32::id),
    }
}

// ---------------------------------------------------------------------------
// The data file
// ---------------------------------------------------------------------------

fn chunk_nonce(counter: u64, last: bool) -> [u8; NONCE_LEN] {
    let mut n = [0u8; NONCE_LEN];
    // 11 big-endian bytes of counter; a u64 fills the low eight.
    n[3..11].copy_from_slice(&counter.to_be_bytes());
    n[11] = u8::from(last);
    n
}

fn chunk_aad(header_digest: &[u8; 32]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(CHUNK_AAD_LABEL.len() + 4 + 32);
    crypto::lp(&mut aad, CHUNK_AAD_LABEL);
    aad.extend_from_slice(header_digest);
    aad
}

fn file_key(backup_key: &Key32, salt: &[u8; SALT_LEN]) -> Key32 {
    let mut info = Vec::with_capacity(DATA_KEY_INFO.len() + 4 + SALT_LEN);
    crypto::lp(&mut info, DATA_KEY_INFO);
    info.extend_from_slice(salt);
    crypto::hkdf_expand(backup_key, &info)
}

/// Writes a data file. Call [`DataWriter::finish`]; a writer dropped without it
/// leaves a file every reader refuses as truncated, which is the point.
pub struct DataWriter<W: Write> {
    out: W,
    key: Key32,
    aad: Vec<u8>,
    buf: Vec<u8>,
    counter: u64,
}

impl<W: Write> DataWriter<W> {
    pub fn new(mut out: W, backup_key: &Key32, label: &Label) -> Result<Self, BackupError> {
        let mut salt = [0u8; SALT_LEN];
        getrandom::fill(&mut salt).map_err(|_| CryptoError::NoRandomness)?;
        let mut header = Vec::new();
        header.extend_from_slice(DATA_MAGIC);
        header.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        crypto::lp(&mut header, &label.encode());
        header.extend_from_slice(&salt);
        out.write_all(&header)?;
        let digest: [u8; 32] = Sha256::digest(&header).into();
        Ok(Self {
            out,
            key: file_key(backup_key, &salt),
            aad: chunk_aad(&digest),
            buf: Vec::with_capacity(CHUNK_LEN),
            counter: 0,
        })
    }

    fn push(&mut self, bytes: &[u8]) -> Result<(), BackupError> {
        let mut rest = bytes;
        while !rest.is_empty() {
            let room = CHUNK_LEN - self.buf.len();
            let take = room.min(rest.len());
            self.buf.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            // A full chunk is only sealed once more bytes are known to follow,
            // so the last chunk is never empty unless the whole stream is.
            if self.buf.len() == CHUNK_LEN && !rest.is_empty() {
                self.seal_chunk(false)?;
            }
        }
        // A buffer left exactly full is sealed, as not-last, by the next frame.
        Ok(())
    }

    fn seal_chunk(&mut self, last: bool) -> Result<(), BackupError> {
        let nonce = chunk_nonce(self.counter, last);
        let ct = crypto::seal(&self.key, &nonce, &self.buf, &self.aad)?;
        self.out.write_all(&ct)?;
        self.buf.clear();
        self.counter += 1;
        Ok(())
    }

    fn frame(&mut self, kind: u8, body: Option<&[u8]>) -> Result<(), BackupError> {
        if self.buf.len() == CHUNK_LEN {
            self.seal_chunk(false)?;
        }
        let mut f = vec![kind];
        if let Some(b) = body {
            crypto::lp(&mut f, b);
        }
        self.push(&f)
    }

    /// Start a file inside the backup.
    pub fn begin_file(&mut self, name: &str) -> Result<(), BackupError> {
        safe_relative(name)?;
        self.frame(FRAME_FILE, Some(name.as_bytes()))
    }

    /// Bytes of the file begun last.
    pub fn write_bytes(&mut self, bytes: &[u8]) -> Result<(), BackupError> {
        for piece in bytes.chunks(64 * 1024) {
            self.frame(FRAME_BYTES, Some(piece))?;
        }
        Ok(())
    }

    /// Copy a reader into the file begun last.
    pub fn copy_from(&mut self, mut r: impl Read) -> Result<u64, BackupError> {
        let mut total = 0u64;
        let mut piece = vec![0u8; 64 * 1024];
        loop {
            let n = match r.read(&mut piece) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.into()),
            };
            self.frame(FRAME_BYTES, Some(&piece[..n]))?;
            total += n as u64;
        }
        Ok(total)
    }

    pub fn end_file(&mut self) -> Result<(), BackupError> {
        self.frame(FRAME_END_FILE, None)
    }

    /// Seal the final chunk and hand back the writer.
    pub fn finish(mut self) -> Result<W, BackupError> {
        self.frame(FRAME_END, None)?;
        self.seal_chunk(true)?;
        self.out.flush()?;
        Ok(self.out)
    }
}

/// One thing read back out of a data file.
#[derive(Debug, PartialEq, Eq)]
pub enum Item {
    FileStart(String),
    Bytes(Vec<u8>),
    FileEnd,
}

/// Reads a data file: the label first, without any key, then the contents.
pub struct DataReader<R: Read> {
    input: R,
    label: Label,
    salt: [u8; SALT_LEN],
    digest: [u8; 32],
}

impl<R: Read> DataReader<R> {
    /// Read the header. Needs no key, so a restore can check the keys file
    /// against the label before anything is decrypted.
    pub fn open(mut input: R) -> Result<Self, BackupError> {
        let mut head = [0u8; 10];
        read_exact_or(&mut input, &mut head, BackupError::NotABackup("data file"))?;
        if &head[..8] != DATA_MAGIC || u16::from_le_bytes([head[8], head[9]]) != FORMAT_VERSION {
            return Err(BackupError::NotABackup("data file"));
        }
        let mut len = [0u8; 4];
        read_exact_or(&mut input, &mut len, BackupError::NotABackup("data file"))?;
        let n = u32::from_le_bytes(len) as usize;
        if n > 64 * 1024 {
            return Err(BackupError::BadLabel);
        }
        let mut label_bytes = vec![0u8; n];
        read_exact_or(
            &mut input,
            &mut label_bytes,
            BackupError::NotABackup("data file"),
        )?;
        let mut salt = [0u8; SALT_LEN];
        read_exact_or(&mut input, &mut salt, BackupError::NotABackup("data file"))?;
        let mut header = Vec::new();
        header.extend_from_slice(&head);
        header.extend_from_slice(&len);
        header.extend_from_slice(&label_bytes);
        header.extend_from_slice(&salt);
        Ok(Self {
            input,
            label: Label::decode(&label_bytes)?,
            salt,
            digest: Sha256::digest(&header).into(),
        })
    }

    pub fn label(&self) -> &Label {
        &self.label
    }

    /// Start decrypting with the backup key.
    pub fn unlock(self, backup_key: &Key32) -> Contents<R> {
        Contents {
            input: self.input,
            key: file_key(backup_key, &self.salt),
            aad: chunk_aad(&self.digest),
            plain: Vec::new(),
            pos: 0,
            counter: 0,
            saw_last: false,
            ended: false,
            pending: None,
        }
    }
}

fn read_exact_or(r: &mut impl Read, buf: &mut [u8], err: BackupError) -> Result<(), BackupError> {
    match r.read_exact(buf) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Err(err),
        Err(e) => Err(e.into()),
    }
}

/// Fill `buf` as far as the input allows; returns how many bytes arrived.
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(got)
}

/// The decrypted contents of a data file, one [`Item`] at a time.
pub struct Contents<R: Read> {
    input: R,
    key: Key32,
    aad: Vec<u8>,
    plain: Vec<u8>,
    pos: usize,
    counter: u64,
    saw_last: bool,
    ended: bool,
    // One byte of look-ahead past a full chunk, to tell "last" from "more".
    pending: Option<u8>,
}

impl<R: Read> Contents<R> {
    fn next_chunk(&mut self) -> Result<(), BackupError> {
        if self.saw_last {
            return Err(BackupError::Damaged);
        }
        let full = CHUNK_LEN + TAG_LEN;
        let mut ct = vec![0u8; full];
        let mut got = 0;
        if let Some(b) = self.pending.take() {
            ct[0] = b;
            got = 1;
        }
        got += read_full(&mut self.input, &mut ct[got..])?;
        if got == 0 {
            return Err(BackupError::Truncated);
        }
        ct.truncate(got);
        // A chunk shorter than full is the last one. A full one is last only
        // if nothing follows it.
        let last = if got < full {
            true
        } else {
            let mut one = [0u8; 1];
            if read_full(&mut self.input, &mut one)? == 0 {
                true
            } else {
                self.pending = Some(one[0]);
                false
            }
        };
        let nonce = chunk_nonce(self.counter, last);
        let plain = match crypto::open(&self.key, &nonce, &ct, &self.aad) {
            Ok(p) => p,
            // A file cut exactly on a chunk boundary: the chunk that is now
            // last was sealed as not-last.
            Err(_)
                if last
                    && crypto::open(
                        &self.key,
                        &chunk_nonce(self.counter, false),
                        &ct,
                        &self.aad,
                    )
                    .is_ok() =>
            {
                return Err(BackupError::Truncated)
            }
            Err(_) => return Err(BackupError::Damaged),
        };
        self.counter += 1;
        self.saw_last = last;
        self.plain.drain(..self.pos);
        self.pos = 0;
        self.plain.extend_from_slice(&plain);
        Ok(())
    }

    fn take(&mut self, n: usize) -> Result<Vec<u8>, BackupError> {
        while self.plain.len() - self.pos < n {
            if self.saw_last {
                return Err(BackupError::Truncated);
            }
            self.next_chunk()?;
        }
        let out = self.plain[self.pos..self.pos + n].to_vec();
        self.pos += n;
        Ok(out)
    }

    fn take_lp(&mut self) -> Result<Vec<u8>, BackupError> {
        let len = self.take(4)?;
        let n = u32::from_le_bytes([len[0], len[1], len[2], len[3]]) as usize;
        if n > CHUNK_LEN {
            return Err(BackupError::Damaged);
        }
        self.take(n)
    }

    /// The next item, or `None` at the authenticated end of the backup.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Result<Option<Item>, BackupError> {
        if self.ended {
            return Ok(None);
        }
        let kind = self.take(1)?[0];
        match kind {
            FRAME_FILE => {
                let name = String::from_utf8(self.take_lp()?).map_err(|_| BackupError::Damaged)?;
                safe_relative(&name)?;
                Ok(Some(Item::FileStart(name)))
            }
            FRAME_BYTES => Ok(Some(Item::Bytes(self.take_lp()?))),
            FRAME_END_FILE => Ok(Some(Item::FileEnd)),
            FRAME_END => {
                // The writer always puts the end frame last in the final chunk.
                if !self.saw_last || self.pos != self.plain.len() {
                    return Err(BackupError::Damaged);
                }
                let mut extra = [0u8; 1];
                if self.pending.is_some() || read_full(&mut self.input, &mut extra)? != 0 {
                    return Err(BackupError::Damaged);
                }
                self.ended = true;
                Ok(None)
            }
            _ => Err(BackupError::Damaged),
        }
    }
}

/// A name inside a backup must be a plain relative path: no root, no `..`, no
/// `.`, nothing empty. Restore writes it under the folder it was given.
pub fn safe_relative(name: &str) -> Result<PathBuf, BackupError> {
    let p = Path::new(name);
    let bad = || BackupError::UnsafeName(name.to_string());
    if name.is_empty() || name.contains('\0') || name.contains('\\') {
        return Err(bad());
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            _ => return Err(bad()),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(bad());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// The recovery phrase
// ---------------------------------------------------------------------------

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// A fresh phrase: 128 bits as 26 RFC 4648 base32 characters, shown in groups
/// of four or five for reading aloud and typing.
pub fn new_phrase() -> Result<String, BackupError> {
    let mut raw = [0u8; PHRASE_BYTES];
    getrandom::fill(&mut raw).map_err(|_| CryptoError::NoRandomness)?;
    Ok(format_phrase(&raw))
}

fn format_phrase(raw: &[u8; PHRASE_BYTES]) -> String {
    let mut bits: u32 = 0;
    let mut n = 0;
    let mut chars = String::new();
    for &b in raw {
        bits = (bits << 8) | u32::from(b);
        n += 8;
        while n >= 5 {
            n -= 5;
            chars.push(B32[((bits >> n) & 31) as usize] as char);
        }
    }
    if n > 0 {
        chars.push(B32[((bits << (5 - n)) & 31) as usize] as char);
    }
    // 26 characters: five groups of four, then one of six would read badly;
    // 4-4-4-4-5-5 keeps every group short.
    let sizes = [4, 4, 4, 4, 5, 5];
    let mut out = Vec::new();
    let mut at = 0;
    for s in sizes {
        out.push(&chars[at..at + s]);
        at += s;
    }
    out.join("-")
}

/// Parse a phrase back to its 16 bytes. Case, spaces and dashes are ignored;
/// `0`, `1` and `8` are read as the letters they are mistaken for.
pub fn parse_phrase(text: &str) -> Result<[u8; PHRASE_BYTES], BackupError> {
    let mut bits: u32 = 0;
    let mut n = 0;
    let mut out = Vec::with_capacity(PHRASE_BYTES);
    let mut count = 0;
    for c in text.chars() {
        let c = match c.to_ascii_uppercase() {
            '-' | ' ' | '\t' | '\n' | '\r' => continue,
            '0' => 'O',
            '1' => 'I',
            '8' => 'B',
            c => c,
        };
        let v = B32
            .iter()
            .position(|&x| x as char == c)
            .ok_or(BackupError::BadPhrase)? as u32;
        count += 1;
        bits = (bits << 5) | v;
        n += 5;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
        }
    }
    if count != 26 || out.len() != PHRASE_BYTES || bits & ((1 << n) - 1) != 0 {
        return Err(BackupError::BadPhrase);
    }
    let mut raw = [0u8; PHRASE_BYTES];
    raw.copy_from_slice(&out);
    Ok(raw)
}

fn phrase_key(
    phrase: &[u8; PHRASE_BYTES],
    salt: &[u8],
    m: u32,
    t: u32,
    p: u32,
) -> Result<Key32, BackupError> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params =
        Params::new(m, t, p, Some(KEY_LEN)).map_err(|_| BackupError::NotABackup("keys file"))?;
    let mut out = [0u8; KEY_LEN];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(phrase, salt, &mut out)
        .map_err(|_| BackupError::NotABackup("keys file"))?;
    Ok(Key32::from_bytes(out))
}

// ---------------------------------------------------------------------------
// The keys file
// ---------------------------------------------------------------------------

/// What a keys file holds: each key-volume file by name, and the ids of the
/// root keys among them.
#[derive(Debug, Default)]
pub struct KeysFile {
    pub label: Label,
    pub files: Vec<(String, Vec<u8>)>,
}

impl KeysFile {
    /// Read every regular file directly inside the key volume.
    pub fn from_dir(dir: &Path) -> Result<Self, BackupError> {
        let mut files = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            // Half-written files from keys-init's `x.new` then `mv`.
            if name.ends_with(".new") {
                continue;
            }
            let bytes = std::fs::read(entry.path())?;
            if bytes.len() > KEYS_ENTRY_MAX {
                continue;
            }
            files.push((name, bytes));
        }
        files.sort();
        let mut kf = Self {
            label: Label::default(),
            files,
        };
        kf.label = Label {
            made_at_unix: now_unix(),
            fathom_version: env!("CARGO_PKG_VERSION").to_string(),
            backup_key: kf.key("backup.key").map(|k| k.id()),
            master_key: kf.key("master.key").map(|k| k.id()),
            chain_key: kf.key("chain.key").map(|k| k.id()),
            vault_key: kf.key("vault.key").map(|k| k.id()),
        };
        Ok(kf)
    }

    /// A 32-byte key held under `name`, accepting the same trailing newline
    /// the key loader does.
    pub fn key(&self, name: &str) -> Option<Key32> {
        let (_, bytes) = self.files.iter().find(|(n, _)| n == name)?;
        let b = bytes.strip_suffix(b"\n").unwrap_or(bytes);
        let arr: [u8; KEY_LEN] = b.try_into().ok()?;
        Some(Key32::from_bytes(arr))
    }

    /// Seal under a phrase. The label stays readable so a restore can say
    /// which keys a file holds before the phrase is typed.
    pub fn seal(&self, phrase: &[u8; PHRASE_BYTES]) -> Result<Vec<u8>, BackupError> {
        let mut salt = [0u8; KEYS_SALT_LEN];
        getrandom::fill(&mut salt).map_err(|_| CryptoError::NoRandomness)?;
        let nonce = crypto::random_nonce()?;
        let mut header = Vec::new();
        header.extend_from_slice(KEYS_MAGIC);
        header.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        crypto::u32_le(&mut header, ARGON2_M_COST);
        crypto::u32_le(&mut header, ARGON2_T_COST);
        crypto::u32_le(&mut header, ARGON2_P_COST);
        header.extend_from_slice(&salt);
        header.extend_from_slice(&nonce);
        crypto::lp(&mut header, &self.label.encode());
        let mut plain = Vec::new();
        for (name, bytes) in &self.files {
            crypto::lp(&mut plain, name.as_bytes());
            crypto::lp(&mut plain, bytes);
        }
        let key = phrase_key(phrase, &salt, ARGON2_M_COST, ARGON2_T_COST, ARGON2_P_COST)?;
        let ct = crypto::seal(&key, &nonce, &plain, &header)?;
        plain.fill(0);
        header.extend_from_slice(&ct);
        Ok(header)
    }

    /// Only the label, with no phrase.
    pub fn peek_label(bytes: &[u8]) -> Result<Label, BackupError> {
        Ok(parse_keys_header(bytes)?.label)
    }

    /// Open with the phrase.
    pub fn open(bytes: &[u8], phrase: &[u8; PHRASE_BYTES]) -> Result<Self, BackupError> {
        let h = parse_keys_header(bytes)?;
        // Refuse costs no honest writer uses, so a crafted file cannot ask for
        // gigabytes of memory.
        if h.m > 1 << 21 || h.t > 64 || h.p > 16 {
            return Err(BackupError::NotABackup("keys file"));
        }
        let key = phrase_key(phrase, &h.salt, h.m, h.t, h.p)?;
        let plain =
            crypto::open(&key, &h.nonce, h.ct, h.header).map_err(|_| BackupError::WrongPhrase)?;
        let mut files = Vec::new();
        let mut rest: &[u8] = &plain;
        while !rest.is_empty() {
            let (name, r) = crypto::read_lp(rest).ok_or(BackupError::NotABackup("keys file"))?;
            let (body, r) = crypto::read_lp(r).ok_or(BackupError::NotABackup("keys file"))?;
            let name = String::from_utf8(name.to_vec())
                .map_err(|_| BackupError::NotABackup("keys file"))?;
            // A key-volume name is one plain component.
            if safe_relative(&name)?.components().count() != 1 {
                return Err(BackupError::UnsafeName(name));
            }
            files.push((name, body.to_vec()));
            rest = r;
        }
        Ok(Self {
            label: h.label,
            files,
        })
    }
}

struct KeysHeader<'a> {
    m: u32,
    t: u32,
    p: u32,
    salt: [u8; KEYS_SALT_LEN],
    nonce: [u8; NONCE_LEN],
    label: Label,
    header: &'a [u8],
    ct: &'a [u8],
}

fn parse_keys_header(bytes: &[u8]) -> Result<KeysHeader<'_>, BackupError> {
    let bad = || BackupError::NotABackup("keys file");
    let fixed = 8 + 2 + 12 + KEYS_SALT_LEN + NONCE_LEN;
    if bytes.len() < fixed + 4 || &bytes[..8] != KEYS_MAGIC {
        return Err(bad());
    }
    if u16::from_le_bytes([bytes[8], bytes[9]]) != FORMAT_VERSION {
        return Err(bad());
    }
    let u32_at =
        |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let (m, t, p) = (u32_at(10), u32_at(14), u32_at(18));
    let mut salt = [0u8; KEYS_SALT_LEN];
    salt.copy_from_slice(&bytes[22..22 + KEYS_SALT_LEN]);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(&bytes[22 + KEYS_SALT_LEN..fixed]);
    let (label_bytes, rest) = crypto::read_lp(&bytes[fixed..]).ok_or_else(bad)?;
    let header_len = bytes.len() - rest.len();
    Ok(KeysHeader {
        m,
        t,
        p,
        salt,
        nonce,
        label: Label::decode(label_bytes)?,
        header: &bytes[..header_len],
        ct: rest,
    })
}

// ---------------------------------------------------------------------------
// Matching a keys file to a data file
// ---------------------------------------------------------------------------

fn short(id: &KeyId) -> String {
    let s = id.to_string();
    format!("{}·{}", &s[..4], &s[4..8])
}

/// Check that `keys` opens `data` and belongs with it, before anything is
/// decrypted. Returns the backup key on success.
///
/// The backup key must match, since nothing opens without it. The master and
/// chain keys must match when the keys file holds them; when it does not, the
/// key came from a `command://` or `env://` source and the operator's own
/// service holds it, which the caller says out loud.
pub fn match_keys(data: &Label, keys: &KeysFile) -> Result<Key32, BackupError> {
    let made = |l: &Label| format!("made {}", date(l.made_at_unix));
    let want = data.backup_key.ok_or(BackupError::BadLabel)?;
    let backup = keys.key("backup.key");
    // Before the phrase is typed only the label is known, so fall back to it.
    let have = backup.as_ref().map(Key32::id).or(keys.label.backup_key);
    if have != Some(want) {
        return Err(BackupError::WrongKeys(format!(
            "nothing was restored. This backup needs backup key {}, and the keys file you gave holds {}. \
             That is the wrong keys file, not a damaged backup: use the keys file made with this install \
             since its last key change (this one was {}).",
            short(&want),
            have.as_ref().map(short).unwrap_or_else(|| "none".into()),
            made(&keys.label),
        )));
    }
    for (what, name, need) in [
        ("master", "master.key", data.master_key),
        ("chain", "chain.key", data.chain_key),
        ("vault", "vault.key", data.vault_key),
    ] {
        if let (Some(need), Some(have)) = (need, keys.key(name)) {
            if have.id() != need {
                return Err(BackupError::WrongKeys(format!(
                    "nothing was restored. This backup was made under {what} key {}, and the keys file holds {what} \
                     key {}. That is the wrong keys file, not a damaged backup. Retired keys are kept forever so an \
                     older backup stays readable: use the keys file from before the key changed.",
                    short(&need),
                    short(&have.id()),
                )));
            }
        }
    }
    backup.ok_or(BackupError::BadLabel)
}

/// Keys the data label names that the keys file does not carry, as operator
/// sentences. Empty when the keys file is complete.
pub fn keys_held_elsewhere(data: &Label, keys: &KeysFile) -> Vec<String> {
    let mut out = Vec::new();
    for (what, name, need) in [
        ("master", "master.key", data.master_key),
        ("chain", "chain.key", data.chain_key),
        ("vault", "vault.key", data.vault_key),
    ] {
        if let Some(need) = need {
            if keys.key(name).is_none() {
                out.push(format!(
                    "the {what} key ({}) is not in the keys file: it comes from your key service \
                     (a command:// or env:// source), which must still return it",
                    short(&need)
                ));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phrase_round_trips_and_forgives_typing() {
        let raw = [0xA5u8; PHRASE_BYTES];
        let p = format_phrase(&raw);
        assert_eq!(p.replace('-', "").len(), 26);
        assert_eq!(parse_phrase(&p).unwrap(), raw);
        assert_eq!(
            parse_phrase(&p.to_lowercase().replace('-', " ")).unwrap(),
            raw
        );
        assert!(parse_phrase("ABCD").is_err());
    }

    #[test]
    fn names_cannot_leave_the_folder() {
        for bad in ["", "/etc/passwd", "../x", "a/../../b", "./a", "a\\b"] {
            assert!(safe_relative(bad).is_err(), "{bad:?}");
        }
        assert!(safe_relative("firmware/ex4300/junos.tgz").is_ok());
    }

    #[test]
    fn dates_read_as_dates() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(1_792_886_400), "2026-10-25");
    }

    #[test]
    fn label_round_trips() {
        let k = Key32::from_bytes([7; 32]);
        let l = label_now(&k, Some(&k), None, None);
        assert_eq!(Label::decode(&l.encode()).unwrap(), l);
    }
}
