//! Mail (ADR-0085): the outbox, the worker that empties it, the SMTP client and the words of
//! each mail.
//!
//! **What a mail may say is the least** (decision 3): what happened, who, when, and a link. A
//! link opens Fathom and never does the thing (decision 2). A mail is never a way in by itself
//! (NIST SP 800-63B rev 4 §3.1.1.2 as ADR-0055 records it): a reset still needs the
//! authenticator code, and an invitation mail carries the link but never the sign-in name,
//! which the Steward hands over another way.
//!
//! Two mails exist today: the password reset (ADR-0055 decision 7) and an invitation link a
//! Steward chose to send by mail. Work, order and security notices follow when their screens do.

pub mod message;
pub mod outbox;
pub mod smtp;

use std::sync::Arc;
use std::time::Duration;

use deadpool_postgres::Pool;

use crate::keys::KeyRing;
use crate::operators::OperatorStore;
use crate::placement::{self, SmtpSettings};

pub use outbox::{Draft, Kind};

/// How often the worker looks for due mail.
pub const TICK: Duration = Duration::from_secs(20);
/// The most mails one tick sends.
pub const BATCH: i64 = 20;

/// What the routes that write mail need: where links point, and the TLS settings the test send
/// uses.
pub struct Mail {
    /// `FATHOM_PUBLIC_URL`: the address people open Fathom at. Unset means no mail with a link
    /// is written at all, because a link built from a request's `Host` header would let anyone
    /// who can send a request choose where a reset link points.
    pub public_url: Option<String>,
    pub tls: Arc<smtp::Tls>,
    /// Where the applied `smtp` setting is read, for a Steward's Mail page to say whether mail
    /// is set up and which address it comes from. Never the password.
    pub operators: Option<Arc<OperatorStore>>,
}

impl Mail {
    /// `public_url` as configured: `https://`, or `http://` to a loopback host, no path, query
    /// or fragment. Checked at startup.
    pub fn new(public_url: Option<String>, tls: Arc<smtp::Tls>) -> Self {
        Self {
            public_url: public_url.map(|u| u.trim_end_matches('/').to_string()),
            tls,
            operators: None,
        }
    }

    /// Let [`Mail::status`] read the applied settings.
    pub fn with_operators(mut self, operators: Arc<OperatorStore>) -> Self {
        self.operators = Some(operators);
        self
    }

    /// Whether mail can go out, and from which address: what a Steward's Mail page shows.
    pub async fn status(&self) -> Status {
        let settings = match &self.operators {
            None => Err(
                "This server's mail is not set up. An operator sets it in the console.".to_string(),
            ),
            Some(o) => applied_settings(o).await,
        };
        Status {
            links: self.public_url.is_some(),
            from_address: settings.as_ref().ok().map(|s| s.from_address.clone()),
            problem: settings.err(),
        }
    }

    /// The link a reset mail carries: the fragment is not sent to the server in the request
    /// line (RFC 3986 §3.5), which `Reset.tsx`'s `tokenFromLocation` reads first.
    pub fn reset_link(&self, token: &[u8]) -> Option<String> {
        Some(format!(
            "{}/#reset={}",
            self.public_url.as_ref()?,
            crate::crypto::hex(token)
        ))
    }

    /// The link an invitation mail carries, the same one the Steward's screen shows
    /// (`client/src/components/console/invitationAddress.ts`).
    pub fn invitation_link(&self, token: &str) -> Option<String> {
        Some(format!("{}/invite#{}", self.public_url.as_ref()?, token))
    }
}

/// What [`Mail::status`] answers.
#[derive(Debug, Clone)]
pub struct Status {
    /// `FATHOM_PUBLIC_URL` is set, so mails with links can be written.
    pub links: bool,
    /// The applied settings' from address, when there are applied settings.
    pub from_address: Option<String>,
    /// Why mail cannot go out, in one sentence, when it cannot.
    pub problem: Option<String>,
}

static INSTALLED: std::sync::OnceLock<Arc<Mail>> = std::sync::OnceLock::new();

/// Set this process's [`Mail`] once, at startup (`main.rs`). A second call is ignored and
/// answers false. The console's test send and the invitation route read it with
/// [`installed`], so their route states need no extra field.
pub fn install(mail: Arc<Mail>) -> bool {
    INSTALLED.set(mail).is_ok()
}

/// What [`install`] set, if anything.
pub fn installed() -> Option<&'static Arc<Mail>> {
    INSTALLED.get()
}

/// The TLS settings to use: the installed ones, or Mozilla's roots alone.
pub fn tls() -> Arc<smtp::Tls> {
    static DEFAULT: std::sync::OnceLock<Arc<smtp::Tls>> = std::sync::OnceLock::new();
    match installed() {
        Some(m) => Arc::clone(&m.tls),
        None => Arc::clone(DEFAULT.get_or_init(|| {
            Arc::new(smtp::Tls::new(None).expect("Mozilla's roots always build a TLS config"))
        })),
    }
}

/// Check `FATHOM_PUBLIC_URL`'s shape. Refused values stop the server at startup.
pub fn check_public_url(url: &str) -> Result<(), &'static str> {
    let url = url.trim_end_matches('/');
    let rest = if let Some(r) = url.strip_prefix("https://") {
        r
    } else if let Some(r) = url.strip_prefix("http://") {
        let host = r.split(':').next().unwrap_or("");
        if !(host == "localhost" || host == "127.0.0.1" || r.starts_with("[::1]")) {
            return Err("FATHOM_PUBLIC_URL must be https://, or http:// to a loopback host");
        }
        r
    } else {
        return Err("FATHOM_PUBLIC_URL must be https://, or http:// to a loopback host");
    };
    if rest.is_empty()
        || rest.contains(['/', '?', '#', '@'])
        || rest.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("FATHOM_PUBLIC_URL is an origin: a scheme and a host, no path");
    }
    Ok(())
}

/// The words of a password-reset mail.
pub fn reset_draft(to: &str, link: &str, expires_at_unix: i64, lifetime_hours: i64) -> Draft {
    let text = format!(
        "Someone asked to reset the password for your Fathom sign-in.\n\n\
         If it was you, open this link within {lifetime_hours} hours:\n\n{link}\n\n\
         The link works once. After you choose a new password, you still sign in with the code \
         from your authenticator app.\n\n\
         If it was not you, ignore this mail. Nothing has changed.\n"
    );
    let html = format!(
        "<p>Someone asked to reset the password for your Fathom sign-in.</p>\
         <p>If it was you, open this link within {lifetime_hours} hours:</p>\
         <p><a href=\"{l}\">Choose a new password</a></p>\
         <p>The link works once. After you choose a new password, you still sign in with the code \
         from your authenticator app.</p>\
         <p>If it was not you, ignore this mail. Nothing has changed.</p>",
        l = message::html_escape(link)
    );
    Draft {
        organisation: None,
        kind: Kind::Reset,
        to: to.to_string(),
        what: "Password reset".to_string(),
        subject: "Reset your Fathom password".to_string(),
        text,
        html,
        expires_at_unix,
    }
}

/// The words of an invitation mail. **No sign-in name**: the link alone lets nobody in.
pub fn invitation_draft(
    organisation: &str,
    organisation_name: &str,
    person: &str,
    to: &str,
    link: &str,
    expires_at_unix: i64,
) -> Draft {
    let until = message::rfc5322_date(expires_at_unix);
    let until = until.get(5..16).unwrap_or(&until).to_string();
    let text = format!(
        "You have been added to {organisation_name} in Fathom.\n\n\
         Open this link to set up your sign-in. It works once, until {until}:\n\n{link}\n\n\
         The person who added you will give you your sign-in name separately. You need both.\n\n\
         If you were not expecting this, ignore this mail.\n"
    );
    let html = format!(
        "<p>You have been added to <b>{o}</b> in Fathom.</p>\
         <p>Open this link to set up your sign-in. It works once, until {until}:</p>\
         <p><a href=\"{l}\">Set up your sign-in</a></p>\
         <p>The person who added you will give you your sign-in name separately. You need \
         both.</p><p>If you were not expecting this, ignore this mail.</p>",
        o = message::html_escape(organisation_name),
        l = message::html_escape(link),
    );
    Draft {
        organisation: Some(organisation.to_string()),
        kind: Kind::Invitation,
        to: to.to_string(),
        what: format!("Invitation for {person}"),
        subject: format!("You have been added to {organisation_name} in Fathom"),
        text,
        html,
        expires_at_unix,
    }
}

/// Write one mail out and hand it to the relay.
pub async fn deliver(
    settings: &SmtpSettings,
    tls: &smtp::Tls,
    id: &str,
    to: &str,
    subject: &str,
    text: &str,
    html: &str,
) -> Result<String, smtp::SendError> {
    let bytes = message::Message {
        from: settings.from_address.clone(),
        to: to.to_string(),
        subject: subject.to_string(),
        text: text.to_string(),
        html: html.to_string(),
        id: id.trim_start_matches("mail_").to_string(),
        date_unix: crate::crypto::now_unix(),
    }
    .render()
    .map_err(|what| smtp::SendError {
        reply: format!("Fathom could not write this mail: {what} is not usable."),
        permanent: true,
    })?;
    smtp::send(settings, tls, to, &bytes).await
}

/// The applied `smtp` setting, or why there is none to use.
pub async fn applied_settings(operators: &OperatorStore) -> Result<SmtpSettings, String> {
    match operators.effective_setting("smtp").await {
        Ok(Some(value)) => placement::parse_smtp_value(&value)
            .map_err(|_| "This server's mail settings could not be read.".to_string()),
        Ok(None) => {
            Err("This server's mail is not set up. An operator sets it in the console.".to_string())
        }
        Err(_) => Err("This server's mail settings could not be checked.".to_string()),
    }
}

/// One pass: claim what is due, send it, record each answer.
pub async fn tick(
    pool: &Pool,
    ring: &Arc<KeyRing>,
    operators: &OperatorStore,
    tls: &smtp::Tls,
) -> Result<usize, outbox::MailError> {
    let due = outbox::claim_due(pool, ring, BATCH).await?;
    if due.is_empty() {
        return Ok(0);
    }
    let settings = applied_settings(operators).await;
    let n = due.len();
    for mail in due {
        let outcome = match &settings {
            Err(why) => outbox::Outcome::Refused {
                reply: why.clone(),
                permanent: true,
            },
            Ok(settings) => match deliver(
                settings,
                tls,
                &mail.id,
                &mail.to,
                &mail.subject,
                &mail.text,
                &mail.html,
            )
            .await
            {
                Ok(reply) => outbox::Outcome::Sent(reply),
                Err(e) => outbox::Outcome::Refused {
                    reply: e.reply,
                    permanent: e.permanent,
                },
            },
        };
        let sent = matches!(outcome, outbox::Outcome::Sent(_));
        outbox::finish(pool, &mail.id, mail.attempts, outcome).await?;
        tracing::info!(mail = %mail.id, sent, "a mail was tried");
    }
    Ok(n)
}

/// The worker: a tick every [`TICK`], and the 90-day clear-out once an hour. Errors are logged
/// and the loop goes on.
pub async fn run(
    pool: Pool,
    ring: Arc<KeyRing>,
    operators: Arc<OperatorStore>,
    tls: Arc<smtp::Tls>,
) {
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut ticks: u64 = 0;
    loop {
        interval.tick().await;
        if let Err(e) = tick(&pool, &ring, &operators, &tls).await {
            tracing::warn!(error = %e, "the mail worker could not finish a pass");
        }
        if ticks.is_multiple_of(180) {
            if let Err(e) = outbox::prune(&pool).await {
                tracing::warn!(error = %e, "the mail worker could not clear old mail");
            }
        }
        ticks = ticks.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_url_is_an_origin() {
        assert!(check_public_url("https://fathom.example.org").is_ok());
        assert!(check_public_url("https://fathom.example.org/").is_ok());
        assert!(check_public_url("http://localhost:8080").is_ok());
        for bad in [
            "http://fathom.example.org",
            "https://fathom.example.org/app",
            "https://a@evil.example",
            "ftp://x",
            "https://",
        ] {
            assert!(check_public_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn an_invitation_mail_never_carries_a_sign_in_name() {
        let d = invitation_draft(
            "org_1",
            "Acme <Ops>",
            "Sam",
            "sam@example.org",
            "https://f.example/invite#inv_00",
            1_794_679_445,
        );
        assert!(d.html.contains("Acme &lt;Ops&gt;"));
        assert!(d.text.contains("sign-in name separately"));
        assert_eq!(d.kind, Kind::Invitation);
    }

    #[test]
    fn links_use_the_configured_origin_only() {
        let m = Mail::new(
            Some("https://f.example/".into()),
            Arc::new(smtp::Tls::new(None).unwrap()),
        );
        assert_eq!(
            m.reset_link(&[0xab, 0x01]).unwrap(),
            "https://f.example/#reset=ab01"
        );
        assert_eq!(
            m.invitation_link("inv_x").unwrap(),
            "https://f.example/invite#inv_x"
        );
        let none = Mail::new(None, Arc::new(smtp::Tls::new(None).unwrap()));
        assert!(none.reset_link(&[1]).is_none());
    }
}
