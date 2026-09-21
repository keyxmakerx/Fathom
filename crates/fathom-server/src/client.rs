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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;

/// The built client, read into memory once at startup and shared by every
/// request: a dozen files, two megabytes, immutable for the life of the
/// image. Serving from memory is what keeps an unauthenticated `GET` of the
/// engine module from costing a file read and a fresh 1.3 MB buffer per
/// request (found by the 2026-09-21 review); a response body here is a
/// refcount on bytes every request shares.
#[derive(Clone, Debug)]
pub struct ClientRoot {
    dir: Arc<PathBuf>,
    files: Arc<HashMap<PathBuf, Bytes>>,
}

/// The most a built client may weigh, in bytes, before startup refuses it:
/// a bound on what this process holds resident for the files, and far
/// above what Vite emits (about 2 MB with the engine).
const MAX_CLIENT_BYTES: u64 = 64 * 1024 * 1024;

impl ClientRoot {
    /// Reads every file under `dir` whose path `safe_relative_path` would
    /// accept. Refuses a root without an `index.html`: a deployment that
    /// names a directory and then answers `/` with 404 is half-working, and
    /// startup is where to say so (`main.rs` exits on `Err`, like every
    /// other refusal to run with a piece missing).
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, String> {
        let dir: PathBuf = dir.into();
        let index = dir.join("index.html");
        match std::fs::metadata(&index) {
            Ok(m) if m.is_file() => {}
            Ok(_) => return Err(format!("{} is not a file", index.display())),
            Err(e) => return Err(format!("{}: {e}", index.display())),
        }
        let mut files = HashMap::new();
        let mut total: u64 = 0;
        let mut pending = vec![PathBuf::new()];
        while let Some(rel_dir) = pending.pop() {
            let entries = std::fs::read_dir(dir.join(&rel_dir))
                .map_err(|e| format!("{}: {e}", dir.join(&rel_dir).display()))?;
            for entry in entries {
                let entry = entry.map_err(|e| format!("{}: {e}", dir.display()))?;
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                let rel = rel_dir.join(name);
                // Only names a request could ever ask for are read at all;
                // a dotfile or an odd name in the directory is not served
                // and not held.
                if safe_relative_path(&format!("/{}", rel.display())).as_deref()
                    != Some(rel.as_path())
                {
                    continue;
                }
                let kind = entry
                    .file_type()
                    .map_err(|e| format!("{}: {e}", entry.path().display()))?;
                if kind.is_dir() {
                    pending.push(rel);
                } else if kind.is_file() {
                    let bytes = std::fs::read(entry.path())
                        .map_err(|e| format!("{}: {e}", entry.path().display()))?;
                    total += bytes.len() as u64;
                    if total > MAX_CLIENT_BYTES {
                        return Err(format!(
                            "{} holds more than {MAX_CLIENT_BYTES} bytes of client files; that is \
                             not a built client",
                            dir.display()
                        ));
                    }
                    files.insert(rel, Bytes::from(bytes));
                }
            }
        }
        Ok(Self {
            dir: Arc::new(dir),
            files: Arc::new(files),
        })
    }

    /// The directory the files were read from.
    pub fn path(&self) -> &Path {
        &self.dir
    }

    /// How many files are held.
    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
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
        // A directory, a missing file and one that was unreadable at startup
        // all read as "not here"; the difference is the operator's to see
        // in the filesystem, not a client's to learn from the status.
        let Some(bytes) = self.files.get(&rel) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        let length = bytes.len();
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from(bytes.clone())
        };
        let mut response = Response::new(body);
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(content_type(&rel)),
        );
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
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

// ---------------------------------------------------------------------------
// ADR-0055 stream (c) -- decision 12's two headers
// ---------------------------------------------------------------------------

/// **A content security policy on every response, and HSTS when a trusted
/// proxy says the request arrived over TLS.** ADR-0055 decision 12, which
/// closes `docs/OPEN-QUESTIONS.md` C5.
///
/// # Where these values come from, and why they are not from memory
///
/// CLAUDE.md rule 1: a CSP named from memory is a security answer from
/// memory. Both values were looked up at build time, on **2026-09-21**, from
/// the OWASP Cheat Sheet Series' own source:
///
/// * <https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/HTTP_Headers_Cheat_Sheet.md>
///   -- HSTS: *"`Strict-Transport-Security: max-age=63072000; includeSubDomains;
///   preload`"*, with its own NOTE that a misconfigured header or a bad
///   certificate locks legitimate users out;
/// * <https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Content_Security_Policy_Cheat_Sheet.md>
///   -- the HTTP-headers sheet defers the directive values to this one, whose
///   tightened basic policy is *"`default-src 'none'; script-src 'self';
///   connect-src 'self'; img-src 'self'; style-src 'self'; frame-ancestors
///   'self'; form-action 'self';`"*.
///
/// # The places this policy differs from that line, each with a reason
///
/// 1. **`'wasm-unsafe-eval'` in `script-src`.** The client loads the Fathom
///    engine as a WebAssembly module. W3C CSP Level 3
///    (<https://raw.githubusercontent.com/w3c/webappsec-csp/main/index.bs>,
///    read 2026-09-21) says of `script-src`: *"The following WebAssembly
///    execution sinks are gated on the `wasm-unsafe-eval` or the
///    `unsafe-eval` source expressions: `new WebAssembly.Module()`,
///    `WebAssembly.compile()`, `WebAssembly.compileStreaming()`,
///    `WebAssembly.instantiate()`, `WebAssembly.instantiateStreaming()`"*,
///    and the same section notes that `wasm-unsafe-eval` *"only permits
///    WebAssembly and does not affect JavaScript"*. So it is the narrower of
///    the two, and `'unsafe-eval'` is NOT here.
/// 2. **`style-src-attr 'unsafe-inline'`, with `style-src` left at `'self'`.**
///    React Flow positions every node with an inline `style` ATTRIBUTE
///    (`transform: translate(...)`), which `style-src` blocks. CSP Level 3
///    splits attributes out: `style-src-attr` governs style attributes,
///    `style-src-elem` governs `<style>` elements and stylesheet links. So
///    inline `<style>` blocks and injected stylesheets stay refused while the
///    diagram keeps working -- the narrowest shape that runs the product, and
///    what `scripts/drive-csp.mjs` proves against the real built client
///    rather than against a belief about it.
/// 3. **`frame-ancestors 'none'` rather than `'self'`.** Nothing in Fathom
///    frames Fathom, and the console is the surface an attacker would want
///    framed.
///
/// `img-src` carries `data:` because Vite inlines small assets as data URIs
/// at build time; `connect-src 'self'` is what the signed-request client
/// needs and no more.
///
/// # What has been PROVEN and what has only been derived
///
/// `scripts/drive-csp.mjs` runs the built client behind this binary in a real
/// Chromium and fails on one violation: the enrolment door, the sign-in form
/// and the port gallery all render with no CSP refusal (run 2026-09-21).
/// **The rack view and the WebAssembly engine are behind a signed-in session
/// and were not in that run**, so `style-src-attr` and `'wasm-unsafe-eval'`
/// rest on the specification and on React Flow's documented behaviour rather
/// than on a drive. That is said here rather than left to be assumed, and the
/// script's own header names the next step.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'none'; script-src 'self' \
     'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data:; style-src 'self'; \
     style-src-attr 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'self'; \
     frame-ancestors 'none'";

/// OWASP's recommendation **without `preload`**, and the omission is a
/// decision rather than an oversight: preloading is a submission to a
/// browser-vendor list that applies to a whole domain and is slow to undo, so
/// it is the deployment's call and not this binary's. Two years and
/// `includeSubDomains` are OWASP's own numbers, read 2026-09-21 at the URL
/// above.
pub const STRICT_TRANSPORT_SECURITY: &str = "max-age=63072000; includeSubDomains";

/// What the header layer needs: how this deployment decides who a request
/// came from, which is the same rule the rate limiter and `admin_exposure`
/// read (`crate::client_address`).
#[derive(Clone, Debug, Default)]
pub struct SecurityHeaders {
    client_address: crate::client_address::ClientAddress,
}

impl SecurityHeaders {
    pub fn new(client_address: crate::client_address::ClientAddress) -> Self {
        Self { client_address }
    }

    /// Whether this request arrived over TLS **as a proxy this deployment
    /// trusts says it did**.
    ///
    /// `X-Forwarded-Proto` is a header any client can write, so it is read
    /// only from a peer inside `FATHOM_TRUSTED_PROXIES` -- the same rule
    /// `ClientAddress` applies to `X-Forwarded-For`, and for the same reason:
    /// HSTS from a forged header would pin a browser to HTTPS for a
    /// deployment that has none, which is a denial of service the person at
    /// the browser cannot undo.
    fn arrived_over_tls(
        &self,
        headers: &axum::http::HeaderMap,
        extensions: &axum::http::Extensions,
    ) -> bool {
        if !crate::placement::from_a_trusted_proxy(&self.client_address, extensions) {
            return false;
        }
        headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            // The last entry, as with `X-Forwarded-For`: the nearest proxy
            // wrote it.
            .and_then(|line| line.rsplit(',').map(str::trim).find(|e| !e.is_empty()))
            .map(|proto| proto.eq_ignore_ascii_case("https"))
            .unwrap_or(false)
    }
}

/// The layer `main.rs` mounts over the whole application.
pub async fn security_headers(
    axum::extract::State(policy): axum::extract::State<SecurityHeaders>,
    request: axum::extract::Request<Body>,
    next: axum::middleware::Next,
) -> Response {
    let over_tls = policy.arrived_over_tls(request.headers(), request.extensions());
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    if over_tls {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static(STRICT_TRANSPORT_SECURITY),
        );
    }
    response
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
