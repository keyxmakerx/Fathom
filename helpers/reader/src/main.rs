//! The device reader's socket. One request per connection, a few connections at a time; the
//! steps themselves are in the library. `FATHOM_READER_SOCKET` names the socket (default
//! `/run/fathom-reader/reader.sock`).

use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn main() {
    let path = std::env::var("FATHOM_READER_SOCKET")
        .unwrap_or_else(|_| "/run/fathom-reader/reader.sock".to_string());
    // A socket left by an earlier run; nothing else is kept in that directory.
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("fathom-reader: cannot listen on {path}: {e}");
            std::process::exit(1);
        }
    };
    // The server and the reader run as the same user; nobody else opens it.
    if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
        eprintln!("fathom-reader: cannot restrict {path}: {e}");
        std::process::exit(1);
    }
    eprintln!("fathom-reader: listening on {path}");
    let busy = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        // One request holds at most one device connection, so this caps those too.
        if busy.fetch_add(1, Ordering::SeqCst) >= fathom_reader::MAX_DEVICE_CONNECTIONS {
            busy.fetch_sub(1, Ordering::SeqCst);
            continue;
        }
        let busy = Arc::clone(&busy);
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
            let _ = fathom_reader::serve_one(&mut stream);
            busy.fetch_sub(1, Ordering::SeqCst);
        });
    }
}
