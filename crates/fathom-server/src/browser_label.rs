//! ADR-0057 decision 8: the label shown for a signed-in browser, derived
//! once at sign-in from the `User-Agent` header — only the label is ever
//! stored, never the header itself.
//!
//! A small matcher rather than a crate: gate zero holds this workspace at
//! zero third-party dependencies.

/// "Firefox on Linux", "Chrome on Windows", "Safari on iPhone" — brand and
/// platform — or "Unknown browser" for anything unrecognised, empty, or too long.
pub fn label(user_agent: &str) -> String {
    if user_agent.is_empty() || user_agent.len() > MAX_LEN {
        return UNKNOWN.to_string();
    }
    match (browser_of(user_agent), os_of(user_agent)) {
        (Some(b), Some(o)) => format!("{b} on {o}"),
        (Some(b), None) => b.to_string(),
        (None, _) => UNKNOWN.to_string(),
    }
}

const UNKNOWN: &str = "Unknown browser";

/// A header longer than any real browser sends is not evidence about a
/// browser; matching against it anyway is a website teaching this label to
/// say whatever it likes.
const MAX_LEN: usize = 512;

/// Order matters: Edge, Opera and other Chromium browsers carry `Chrome/`
/// (Blink's shared token), and Chrome itself carries `Safari/` (WebKit's
/// inherited token) — so the more specific brand is checked first.
fn browser_of(ua: &str) -> Option<&'static str> {
    if ua.contains("Edg/") || ua.contains("EdgA/") || ua.contains("EdgiOS/") {
        Some("Edge")
    } else if ua.contains("OPR/") || ua.contains("Opera") {
        Some("Opera")
    } else if ua.contains("Firefox/") || ua.contains("FxiOS/") {
        Some("Firefox")
    } else if ua.contains("Chrome/") || ua.contains("CriOS/") {
        Some("Chrome")
    } else if ua.contains("Safari/") && ua.contains("Version/") {
        // Chrome, Edge and Opera all carry "Safari/"; "Version/" is Safari's
        // own token and none of the Chromium browsers write it.
        Some("Safari")
    } else {
        None
    }
}

fn os_of(ua: &str) -> Option<&'static str> {
    if ua.contains("iPhone") {
        Some("iPhone")
    } else if ua.contains("iPad") {
        Some("iPad")
    } else if ua.contains("Android") {
        Some("Android")
    } else if ua.contains("Windows") {
        Some("Windows")
    } else if ua.contains("Mac OS X") || ua.contains("Macintosh") {
        Some("Mac")
    } else if ua.contains("Linux") {
        Some("Linux")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firefox_on_linux() {
        assert_eq!(
            label("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"),
            "Firefox on Linux"
        );
    }

    #[test]
    fn chrome_on_windows() {
        assert_eq!(
            label(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like \
                 Gecko) Chrome/128.0.0.0 Safari/537.36"
            ),
            "Chrome on Windows"
        );
    }

    #[test]
    fn safari_on_iphone() {
        assert_eq!(
            label(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 \
                 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
            ),
            "Safari on iPhone"
        );
    }

    #[test]
    fn safari_on_mac() {
        assert_eq!(
            label(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, \
                 like Gecko) Version/17.5 Safari/605.1.15"
            ),
            "Safari on Mac"
        );
    }

    #[test]
    fn edge_and_opera_are_not_mistaken_for_chrome_or_safari() {
        assert_eq!(
            label(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like \
                 Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0"
            ),
            "Edge on Windows"
        );
        assert_eq!(
            label(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like \
                 Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0"
            ),
            "Opera on Windows"
        );
    }

    #[test]
    fn chrome_on_android() {
        assert_eq!(
            label(
                "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like \
                 Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
            ),
            "Chrome on Android"
        );
    }

    #[test]
    fn unrecognised_empty_or_overlong_is_unknown_browser() {
        assert_eq!(label("curl/8.4.0"), "Unknown browser");
        assert_eq!(label(""), "Unknown browser");
        assert_eq!(
            label(&"Mozilla/5.0 Chrome/1 ".repeat(60)),
            "Unknown browser"
        );
    }
}
