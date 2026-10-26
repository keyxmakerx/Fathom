//! ADR-0070: the data file and the keys file, against what can go wrong with a
//! real backup — a copy cut short, a byte flipped on a bad disk, chunks in the
//! wrong order, and the wrong keys file picked up from the shelf.

use std::io::Cursor;

use fathom_server::backup::{
    self, BackupError, DataReader, DataWriter, Item, KeysFile, Label, CHUNK_LEN, DUMP_NAME,
};
use fathom_server::backup_cli::{check_restore, write_backup};
use fathom_server::crypto::Key32;

fn key(b: u8) -> Key32 {
    Key32::from_bytes([b; 32])
}

fn label_for(k: &Key32, master: &Key32) -> Label {
    backup::label_now(k, Some(master), None, None)
}

/// A dump-shaped input: the custom-format magic, then `n` bytes that are not
/// all one value, so a chunk swap changes the plaintext.
fn dump(n: usize) -> Vec<u8> {
    let mut v = b"PGDMP".to_vec();
    v.extend((0..n).map(|i| (i % 251) as u8));
    v
}

fn sealed(k: &Key32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    write_backup(Cursor::new(body), &mut out, k, &label_for(k, &key(9)), None).unwrap();
    out
}

fn read_all(bytes: &[u8], k: &Key32) -> Result<Vec<(String, Vec<u8>)>, BackupError> {
    let r = DataReader::open(Cursor::new(bytes))?;
    let mut c = r.unlock(k);
    let mut files = Vec::new();
    while let Some(item) = c.next()? {
        match item {
            Item::FileStart(n) => files.push((n, Vec::new())),
            Item::Bytes(b) => files.last_mut().unwrap().1.extend_from_slice(&b),
            Item::FileEnd => {}
        }
    }
    Ok(files)
}

#[test]
fn a_dump_round_trips_across_several_chunks() {
    let k = key(1);
    let body = dump(3 * CHUNK_LEN + 12_345);
    let files = read_all(&sealed(&k, &body), &k).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, DUMP_NAME);
    assert_eq!(files[0].1, body);
}

#[test]
fn firmware_rides_along_under_its_own_names() {
    let k = key(1);
    let dir = tempdir();
    std::fs::create_dir_all(dir.join("ex4300")).unwrap();
    std::fs::write(
        dir.join("ex4300/junos-23.4R2.tgz"),
        vec![7u8; CHUNK_LEN + 3],
    )
    .unwrap();
    std::fs::write(dir.join("readme.txt"), b"hello").unwrap();
    let mut out = Vec::new();
    let (_, count, bytes) = write_backup(
        Cursor::new(dump(10)),
        &mut out,
        &k,
        &label_for(&k, &key(9)),
        Some(&dir),
    )
    .unwrap();
    assert_eq!((count, bytes), (2, CHUNK_LEN as u64 + 3 + 5));
    let names: Vec<String> = read_all(&out, &k)
        .unwrap()
        .into_iter()
        .map(|f| f.0)
        .collect();
    assert_eq!(
        names,
        vec![
            DUMP_NAME.to_string(),
            "firmware/ex4300/junos-23.4R2.tgz".to_string(),
            "firmware/readme.txt".to_string()
        ]
    );
}

#[test]
fn something_that_is_not_a_custom_format_dump_is_refused_at_backup_time() {
    let k = key(1);
    let mut out = Vec::new();
    let plain_sql = b"--\n-- PostgreSQL database dump\n--\n".to_vec();
    assert!(write_backup(
        Cursor::new(plain_sql),
        &mut out,
        &k,
        &Label::default(),
        None
    )
    .is_err());
    assert!(write_backup(
        Cursor::new(Vec::new()),
        &mut out,
        &k,
        &Label::default(),
        None
    )
    .is_err());
}

#[test]
fn the_wrong_backup_key_opens_nothing() {
    let file = sealed(&key(1), &dump(100));
    assert!(matches!(
        read_all(&file, &key(2)),
        Err(BackupError::Damaged)
    ));
}

#[test]
fn a_copy_cut_short_is_called_truncated_not_finished() {
    let k = key(1);
    let file = sealed(&k, &dump(2 * CHUNK_LEN + 50));
    let header = header_len(&file);
    // Cut exactly on a chunk boundary: every remaining chunk verifies, and the
    // last one was sealed as not-last.
    let on_boundary = &file[..header + CHUNK_LEN + 16];
    assert!(matches!(
        read_all(on_boundary, &k),
        Err(BackupError::Truncated)
    ));
    // Cut mid-chunk.
    let mid = &file[..file.len() - 7];
    assert!(read_all(mid, &k).is_err());
    // Cut inside the header.
    assert!(read_all(&file[..20], &k).is_err());
}

#[test]
fn one_flipped_byte_anywhere_after_the_magic_is_refused() {
    let k = key(1);
    let file = sealed(&k, &dump(CHUNK_LEN + 99));
    for at in [12, 40, file.len() / 2, file.len() - 1] {
        let mut bad = file.clone();
        bad[at] ^= 0x01;
        assert!(read_all(&bad, &k).is_err(), "flip at {at} was accepted");
    }
}

#[test]
fn chunks_cannot_be_reordered_or_moved_to_another_file() {
    let k = key(1);
    let body = dump(3 * CHUNK_LEN);
    let a = sealed(&k, &body);
    let b = sealed(&k, &body);
    let chunk = CHUNK_LEN + 16;
    let hlen = header_len(&a);
    // Swap chunks 0 and 1.
    let mut swapped = a.clone();
    let (c0, c1) = (hlen..hlen + chunk, hlen + chunk..hlen + 2 * chunk);
    let tmp = swapped[c0.clone()].to_vec();
    swapped.copy_within(c1.clone(), c0.start);
    swapped[c1].copy_from_slice(&tmp);
    assert!(read_all(&swapped, &k).is_err());
    // File a's header on file b's chunks: each file has its own salt and key.
    let mut spliced = a[..hlen].to_vec();
    spliced.extend_from_slice(&b[hlen..]);
    assert!(read_all(&spliced, &k).is_err());
}

/// Magic, version, the length-prefixed label, the 32-byte salt.
fn header_len(file: &[u8]) -> usize {
    10 + 4 + u32::from_le_bytes(file[10..14].try_into().unwrap()) as usize + 32
}

#[test]
fn a_finished_writer_is_required() {
    let k = key(1);
    let mut out = Vec::new();
    {
        let mut w = DataWriter::new(&mut out, &k, &Label::default()).unwrap();
        w.begin_file(DUMP_NAME).unwrap();
        w.write_bytes(b"PGDMP").unwrap();
        // dropped without finish()
    }
    assert!(read_all(&out, &k).is_err());
}

// ---------------------------------------------------------------------------
// The keys file
// ---------------------------------------------------------------------------

fn key_volume(master: u8, backup: u8) -> std::path::PathBuf {
    let dir = tempdir();
    std::fs::write(dir.join("master.key"), [master; 32]).unwrap();
    std::fs::write(dir.join("chain.key"), [master ^ 0xff; 32]).unwrap();
    std::fs::write(dir.join("backup.key"), [backup; 32]).unwrap();
    std::fs::write(dir.join("db_app.pw"), b"0123abcd\n").unwrap();
    std::fs::write(dir.join("master.key.new"), b"half written").unwrap();
    dir
}

/// ADR-0071's `vault.key` (Mode B) sits in the key volume beside the others,
/// so it travels in the keys file and its id goes on the label, which is what
/// lets the Backups screen say when a keys file was made before it existed.
#[test]
fn the_vault_key_joins_the_keys_file_and_its_label() {
    let dir = key_volume(3, 1);
    let before = KeysFile::from_dir(&dir).unwrap();
    assert_eq!(before.label.vault_key, None);
    std::fs::write(dir.join("vault.key"), [7u8; 32]).unwrap();
    let kf = KeysFile::from_dir(&dir).unwrap();
    assert!(kf
        .files
        .iter()
        .any(|(n, b)| n == "vault.key" && b == &[7u8; 32]));
    assert_eq!(kf.label.vault_key, Some(key(7).id()));
    let phrase = backup::parse_phrase(&backup::new_phrase().unwrap()).unwrap();
    let back = KeysFile::open(&kf.seal(&phrase).unwrap(), &phrase).unwrap();
    assert_eq!(back.key("vault.key").map(|k| k.id()), Some(key(7).id()));
}

#[test]
fn the_keys_file_round_trips_under_its_phrase_and_nothing_else() {
    let kf = KeysFile::from_dir(&key_volume(3, 1)).unwrap();
    let names: Vec<&str> = kf.files.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(
        names,
        ["backup.key", "chain.key", "db_app.pw", "master.key"]
    );
    let phrase = backup::parse_phrase(&backup::new_phrase().unwrap()).unwrap();
    let sealed = kf.seal(&phrase).unwrap();
    // No key bytes in the clear.
    assert!(!sealed.windows(32).any(|w| w == [3u8; 32] || w == [1u8; 32]));
    let back = KeysFile::open(&sealed, &phrase).unwrap();
    assert_eq!(back.files, kf.files);
    let other = backup::parse_phrase(&backup::new_phrase().unwrap()).unwrap();
    assert!(matches!(
        KeysFile::open(&sealed, &other),
        Err(BackupError::WrongPhrase)
    ));
    // Its label is readable without the phrase, and cannot be edited.
    assert_eq!(
        KeysFile::peek_label(&sealed).unwrap().backup_key,
        Some(key(1).id())
    );
    let mut edited = sealed.clone();
    let at = sealed.len() - 20;
    edited[at] ^= 1;
    assert!(KeysFile::open(&edited, &phrase).is_err());
}

#[test]
fn the_right_keys_file_opens_the_backup_and_the_wrong_one_is_named() {
    let kf = KeysFile::from_dir(&key_volume(3, 1)).unwrap();
    // Labelled as made under these master and chain keys, as the command does.
    let mut label_data = Vec::new();
    write_backup(
        Cursor::new(dump(1000)),
        &mut label_data,
        &key(1),
        &backup::label_now(&key(1), Some(&key(3)), Some(&key(3 ^ 0xff)), None),
        None,
    )
    .unwrap();

    let r = DataReader::open(Cursor::new(&label_data)).unwrap();
    let bkey = backup::match_keys(r.label(), &kf).unwrap();
    assert_eq!(check_restore(r, &bkey).unwrap().0, 1);

    // A keys file from another install (another backup key).
    let other = KeysFile::from_dir(&key_volume(3, 2)).unwrap();
    let r = DataReader::open(Cursor::new(&label_data)).unwrap();
    let e = backup::match_keys(r.label(), &other)
        .unwrap_err()
        .to_string();
    assert!(
        e.contains("wrong keys file") && e.contains("not a damaged backup"),
        "{e}"
    );

    // The same backup key but a rotated master key.
    let rotated = KeysFile::from_dir(&key_volume(4, 1)).unwrap();
    let r = DataReader::open(Cursor::new(&label_data)).unwrap();
    let e = backup::match_keys(r.label(), &rotated)
        .unwrap_err()
        .to_string();
    assert!(e.contains("master key"), "{e}");
}

#[test]
fn a_master_key_from_a_key_service_is_said_out_loud() {
    let dir = tempdir();
    std::fs::write(dir.join("backup.key"), [1u8; 32]).unwrap();
    let kf = KeysFile::from_dir(&dir).unwrap();
    let label = backup::label_now(&key(1), Some(&key(3)), None, None);
    assert!(backup::match_keys(&label, &kf).is_ok());
    let notes = backup::keys_held_elsewhere(&label, &kf);
    assert_eq!(notes.len(), 1);
    assert!(notes[0].contains("master key") && notes[0].contains("key service"));
}

fn tempdir() -> std::path::PathBuf {
    let mut raw = [0u8; 8];
    getrandom::fill(&mut raw).unwrap();
    let name: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("fathom-backup-test-{name}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
