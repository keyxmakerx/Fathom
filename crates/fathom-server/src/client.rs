//! The web client, served by the server itself.
//!
//! `FATHOM_CLIENT_ROOT` names a directory of built client files
//! (`client/dist`, which `deploy/Dockerfile` bakes into the image at
//! `/srv/www`), and every request no API route claims is answered from it.
//! Added 2026-09-20, when Caddy left the stack: every other service the
//! operator runs is one published port behind their own reverse proxy, and
//! this one carried a second proxy inside it only because the binary did not
//! serve a handful of files. HTTPS is that proxy's job. The browser's
//! WebCrypto, which generates the sign-in key, needs a secure context, so
//! plain HTTP works only on `localhost`; `docs/RUNNING-IT.md` says so.
//!
//! No crate arrives with this. A file server that answers `GET` for a flat,
//! content-hashed set of files and refuses everything else is a page of
//! code, and `tower-http`'s would be a new package in the closure gate-zero
//! measures (WO-11 §5).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;

/// The directory, resolved once at startup and shared by every request.
#[derive(Clone, Debug)]
pub struct ClientRoot(Arc<PathBuf>);

impl ClientRoot {
    /// Refuses a root without an `index.html`. A deployment that names a
    /// directory and then answers `/` with 404 is half-working, and startup
    /// is where to say so (`main.rs` exits on `Err`, like every other
    /// refusal to run with a piece missing).
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, String> {
        let dir: PathBuf = dir.into();
        let index = dir.join("index.html");
        match std::fs::metadata(&index) {
            Ok(m) if m.is_file() => Ok(Self(Arc::new(dir))),
            Ok(_) => Err(format!("{} is not a file", index.display())),
            Err(e) => Err(format!("{}: {e}", index.display())),
        }
    }

    /// The directory being served.
    pub fn path(&self) -> &Path {
        &self.0
    }

    /// `router` with this root as its fallback: every path no route claims
    /// is looked up here, so API routes always win over a file of the same
    /// name.
    pub fn attach(self, router: Router) -> Router {
        router.fallback(move |method: Method, uri: Uri| self.clone().serve(method, uri))
    }

    /// `GET` or `HEAD` of a safe path under the root, or 404. Any other
    /// method is 404 too: nothing here takes one, and a method list on a
    /// fallback would only advertise it.
    pub async fn serve(self, method: Method, uri: Uri) -> Response {
        if method != Method::GET && method != Method::HEAD {
            return StatusCode::NOT_FOUND.into_response();
        }
        let Some(rel) = safe_relative_path(uri.path()) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        // A directory, a missing file and an unreadable one all read as
        // "not here"; the difference is the operator's to see in the
        // filesystem, not a client's to learn from the status.
        let bytes = match tokio::fs::read(self.0.join(&rel)).await {
            Ok(b) => b,
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        };
        let mut response = Response::new(Body::from(bytes));
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(content_type(&rel)),
        );
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static(cache_control(&rel)),
        );
        response
    }
}

/// The path a request may name, or `None`. `/` is `index.html`; anything
/// else is a run of segments each made only of ASCII letters, digits, `.`,
/// `-` and `_`, none empty and none starting with a dot -- which is every
/// file Vite emits and nothing that can climb out of the root (`..`, a
/// percent-encoding, a backslash, an absolute path). Refusing is cheaper
/// than canonicalising and provably tighter: the accepted set is exactly the
/// names in a built client.
fn safe_relative_path(path: &str) -> Option<PathBuf> {
    if path == "/" || path.is_empty() {
        return Some(PathBuf::from("index.html"));
    }
    let rest = path.strip_prefix('/')?;
    let mut out = PathBuf::new();
    for segment in rest.split('/') {
        if segment.is_empty() || segment.starts_with('.') {
            return None;
        }
        if !segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
        {
            return None;
        }
        out.push(segment);
    }
    Some(out)
}

/// By extension, for the set a built client contains. Anything else is
/// bytes, which a browser will not render as a document.
fn content_type(rel: &Path) -> &'static str {
    match rel.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("json") | Some("map") => "application/json",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") | Some("sha256") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Vite names everything under `assets/` by content hash, so those may be
/// cached for as long as a browser likes; `index.html` and the engine module
/// keep their names across builds and must be re-checked.
fn cache_control(rel: &Path) -> &'static str {
    if rel.starts_with("assets") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_root_is_index_html() {
        assert_eq!(safe_relative_path("/"), Some(PathBuf::from("index.html")));
    }

    #[test]
    fn a_built_client_s_names_pass() {
        for p in [
            "/assets/main-C-6-9l4M.js",
            "/engine/fathom_wasm.wasm",
            "/favicon.svg",
            "/ports.html",
        ] {
            assert!(safe_relative_path(p).is_some(), "{p}");
        }
    }

    #[test]
    fn nothing_that_climbs_or_hides_passes() {
        for p in [
            "/../Cargo.toml",
            "/assets/../../Cargo.toml",
            "/assets/..",
            "/.env",
            "/assets/.hidden",
            "/a%2e%2e/b",
            "/a\\b",
            "//etc/passwd",
            "/assets/",
            "/a b",
        ] {
            assert_eq!(safe_relative_path(p), None, "{p}");
        }
    }

    #[test]
    fn hashed_assets_are_immutable_and_the_rest_are_not() {
        assert_eq!(
            cache_control(Path::new("assets/main-abc.js")),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(cache_control(Path::new("index.html")), "no-cache");
        assert_eq!(
            cache_control(Path::new("engine/fathom_wasm.wasm")),
            "no-cache"
        );
    }
}
