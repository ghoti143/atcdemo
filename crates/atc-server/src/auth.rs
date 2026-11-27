//! Who is connecting: verifying the token a socket request carries.
//!
//! The web app signs a short-lived JWT for the signed-in user and the
//! browser puts it in the socket's query string (docs/DESIGN.md section 11).
//! This module checks it with the web app's public keys alone. There is no
//! shared secret, and the token's `role` claim is the only authority the
//! server has about a user.
//!
//! A token is never logged. [`Token`] cannot be printed, and the reasons a
//! connection is refused name what was wrong, not what was sent.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::{Mutex, RwLock};
use tracing::{info, warn};

use crate::config::Auth;
use crate::hub::{Role, User};

/// How long the request for the signing keys may take.
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
/// The least time between two requests for the signing keys. A token naming
/// a key the server has not seen makes it ask again, and anyone can send
/// such a token, so asking is rationed.
pub const DEFAULT_REFETCH_INTERVAL: Duration = Duration::from_secs(10);
/// How far the web app's clock and this one may disagree about a token's
/// times.
const LEEWAY_S: u64 = 30;
/// The most keys taken from one answer. Better Auth publishes one.
const MAX_KEYS: usize = 16;
/// The length of an Ed25519 public key in base64url without padding.
const ED25519_KEY_CHARS: usize = 43;
/// The largest answer read from the keys URL.
const MAX_JWKS_BYTES: usize = 64 * 1024;

/// A token as it arrived. It has no `Display`, and its `Debug` prints
/// nothing of it, so it cannot reach a log by accident.
#[derive(Clone, Deserialize)]
#[serde(transparent)]
pub struct Token(String);

impl Token {
    pub fn new(token: impl Into<String>) -> Token {
        Token(token.into())
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

/// Why a connection was turned away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The request carried no token.
    Missing,
    /// The token is not one this server accepts: malformed, signed with an
    /// algorithm other than EdDSA, signed by a key the web app does not
    /// publish, altered, or issued by or for someone else.
    Invalid(&'static str),
    /// The token was good and its time has passed.
    Expired,
    /// The signing keys could not be fetched, so nothing can be verified.
    /// Not the client's fault, and worth its trying again.
    KeysUnavailable,
}

impl Refusal {
    /// The HTTP status the upgrade request is answered with.
    pub fn status(self) -> StatusCode {
        match self {
            Refusal::KeysUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            _ => StatusCode::UNAUTHORIZED,
        }
    }

    /// What the response says, and the log. Never anything from the token.
    pub fn message(self) -> &'static str {
        match self {
            Refusal::Missing => "a token is required",
            Refusal::Invalid(why) => why,
            Refusal::Expired => "the token has expired",
            Refusal::KeysUnavailable => "the signing keys could not be fetched",
        }
    }
}

/// The claims the server reads. `exp`, `iss` and `aud` are checked by the
/// validation and need no field.
#[derive(Deserialize)]
struct Claims {
    sub: String,
    role: String,
}

/// How socket requests are authenticated. Cheap to clone.
#[derive(Clone)]
pub enum Authenticator {
    /// `ATC_AUTH=off`: everyone is the dev user.
    Off,
    Verify(Arc<Verifier>),
}

impl From<Auth> for Authenticator {
    fn from(auth: Auth) -> Authenticator {
        match auth {
            Auth::Off => Authenticator::Off,
            Auth::Jwks { url, issuer } => {
                Authenticator::Verify(Arc::new(Verifier::new(url, issuer)))
            }
        }
    }
}

impl Authenticator {
    /// Who the request's token says is connecting.
    pub async fn authenticate(&self, token: Option<&Token>) -> Result<User, Refusal> {
        match self {
            Authenticator::Off => Ok(User::dev()),
            Authenticator::Verify(verifier) => match token {
                Some(token) => verifier.verify(token).await,
                None => Err(Refusal::Missing),
            },
        }
    }
}

#[derive(Default)]
struct KeyCache {
    by_id: HashMap<String, DecodingKey>,
    /// When the keys were last asked for, whether or not they came.
    asked: Option<Instant>,
    /// Whether that request failed.
    failed: bool,
}

/// Verifies tokens against the keys published at a URL, which it fetches
/// when it first needs one and again when a token names a key it does not
/// have.
pub struct Verifier {
    jwks_url: String,
    validation: Validation,
    http: reqwest::Client,
    keys: RwLock<KeyCache>,
    /// Held while the keys are being fetched, so a burst of connections
    /// makes one request.
    fetching: Mutex<()>,
    refetch_interval: Duration,
}

impl Verifier {
    /// A verifier for tokens issued by, and for, `issuer`: the web app's
    /// public URL, which Better Auth puts in both `iss` and `aud`.
    pub fn new(jwks_url: impl Into<String>, issuer: impl AsRef<str>) -> Verifier {
        Verifier::with_refetch_interval(jwks_url, issuer, DEFAULT_REFETCH_INTERVAL)
    }

    /// As [`Verifier::new`], asking for the keys at most once in
    /// `refetch_interval`.
    pub fn with_refetch_interval(
        jwks_url: impl Into<String>,
        issuer: impl AsRef<str>,
        refetch_interval: Duration,
    ) -> Verifier {
        // Only EdDSA: a token that names any other algorithm, `none`
        // included, is refused before its signature is looked at.
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.leeway = LEEWAY_S;
        validation.set_issuer(&[issuer.as_ref()]);
        validation.set_audience(&[issuer.as_ref()]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);

        Verifier {
            jwks_url: jwks_url.into(),
            validation,
            http: reqwest::Client::builder()
                .timeout(FETCH_TIMEOUT)
                // The keys URL is configuration; a redirect from it is not.
                .redirect(reqwest::redirect::Policy::none())
                .use_preconfigured_tls(tls_config())
                .build()
                .expect("build the HTTP client"),
            keys: RwLock::default(),
            fetching: Mutex::default(),
            refetch_interval,
        }
    }

    /// Checks the token's signature, expiry, issuer and audience, and reads
    /// who it is for.
    pub async fn verify(&self, token: &Token) -> Result<User, Refusal> {
        let header = jsonwebtoken::decode_header(&token.0)
            .map_err(|_| Refusal::Invalid("the token is not a signed token"))?;
        if header.alg != Algorithm::EdDSA {
            return Err(Refusal::Invalid("the token is not signed with EdDSA"));
        }
        let Some(key_id) = header.kid else {
            return Err(Refusal::Invalid("the token does not name its key"));
        };
        let key = self.key(&key_id).await?;

        let claims = jsonwebtoken::decode::<Claims>(&token.0, &key, &self.validation)
            .map_err(|error| match error.kind() {
                ErrorKind::ExpiredSignature => Refusal::Expired,
                ErrorKind::InvalidSignature => Refusal::Invalid("the token's signature is wrong"),
                ErrorKind::InvalidIssuer => Refusal::Invalid("the token is from another issuer"),
                ErrorKind::InvalidAudience => Refusal::Invalid("the token is for another audience"),
                ErrorKind::MissingRequiredClaim(_) => {
                    Refusal::Invalid("the token lacks a required claim")
                }
                _ => Refusal::Invalid("the token could not be verified"),
            })?
            .claims;

        // The web app issues exactly these two. Anything else is not a
        // token this server understands, and is not guessed at.
        let role = match claims.role.as_str() {
            "viewer" => Role::Viewer,
            "controller" => Role::Controller,
            _ => return Err(Refusal::Invalid("the token names an unknown role")),
        };
        if claims.sub.is_empty() {
            return Err(Refusal::Invalid("the token names no user"));
        }
        Ok(User {
            id: claims.sub,
            role,
        })
    }

    /// The key with this id, fetching the keys if it is not known.
    async fn key(&self, key_id: &str) -> Result<DecodingKey, Refusal> {
        if let Some(key) = self.keys.read().await.by_id.get(key_id) {
            return Ok(key.clone());
        }

        let _fetching = self.fetching.lock().await;
        // Another request may have fetched them while this one waited.
        {
            let cache = self.keys.read().await;
            if let Some(key) = cache.by_id.get(key_id) {
                return Ok(key.clone());
            }
            let asked_lately = cache
                .asked
                .is_some_and(|at| at.elapsed() < self.refetch_interval);
            if asked_lately {
                return Err(if cache.failed {
                    Refusal::KeysUnavailable
                } else {
                    Refusal::Invalid("the token is signed by an unknown key")
                });
            }
        }

        let fetched = self.fetch().await;
        let mut cache = self.keys.write().await;
        cache.asked = Some(Instant::now());
        match fetched {
            Ok(keys) => {
                info!(
                    "fetched {} signing key(s) from {}",
                    keys.len(),
                    self.jwks_url
                );
                cache.failed = false;
                cache.by_id = keys;
            }
            Err(problem) => {
                // The keys held are kept: the web app being down for a
                // moment does not make tokens it signed earlier bad.
                warn!(
                    "could not fetch the signing keys from {}: {problem}",
                    self.jwks_url
                );
                cache.failed = true;
                return Err(Refusal::KeysUnavailable);
            }
        }
        cache
            .by_id
            .get(key_id)
            .cloned()
            .ok_or(Refusal::Invalid("the token is signed by an unknown key"))
    }

    /// Asks the web app for its public keys.
    async fn fetch(&self) -> Result<HashMap<String, DecodingKey>, String> {
        let response = self
            .http
            .get(&self.jwks_url)
            .send()
            .await
            .map_err(|error| describe(&error))?;
        if !response.status().is_success() {
            return Err(format!("it answered HTTP {}", response.status().as_u16()));
        }
        let body = response.bytes().await.map_err(|error| describe(&error))?;
        if body.len() > MAX_JWKS_BYTES {
            return Err(format!("the answer is {} bytes", body.len()));
        }
        parse_jwks(&body)
    }
}

/// TLS for an `https://` keys URL, trusting the certificate authorities
/// compiled into the binary and not the machine's.
///
/// reqwest would otherwise read the system's certificates when the client is
/// built, and fail to build it when there are none. The server's image has
/// none, so the server could not start there, even to fetch keys over plain
/// HTTP. The provider is `ring`, which `sqlx` already brings.
fn tls_config() -> rustls::ClientConfig {
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

/// A request error with its causes, which is where reqwest keeps the reason.
fn describe(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

/// One published key, as far as it is read. Other kinds of key are skipped.
#[derive(Deserialize)]
struct Jwk {
    kty: Option<String>,
    crv: Option<String>,
    kid: Option<String>,
    x: Option<String>,
}

/// Reads a JWK set, keeping its Ed25519 keys by id. A set with none is an
/// error: the web app signs with one, so its absence is a wrong URL or a
/// wrong answer.
fn parse_jwks(body: &[u8]) -> Result<HashMap<String, DecodingKey>, String> {
    let jwks: Jwks =
        serde_json::from_slice(body).map_err(|error| format!("not a key set: {error}"))?;
    let mut keys = HashMap::new();
    for jwk in jwks.keys.into_iter().take(MAX_KEYS) {
        let (Some("OKP"), Some("Ed25519")) = (jwk.kty.as_deref(), jwk.crv.as_deref()) else {
            continue;
        };
        let (Some(id), Some(x)) = (jwk.kid, jwk.x) else {
            continue;
        };
        // An Ed25519 public key is 32 bytes: 43 characters of base64url.
        // Anything else is not a key, and is not handed to the verifier.
        if x.len() != ED25519_KEY_CHARS {
            continue;
        }
        if let Ok(key) = DecodingKey::from_ed_components(&x) {
            keys.insert(id, key);
        }
    }
    if keys.is_empty() {
        return Err("the key set holds no Ed25519 key with an id".to_owned());
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_cannot_be_printed() {
        let token = Token::new("aaa.bbb.ccc");
        assert_eq!(format!("{token:?}"), "Token(<redacted>)");
        assert_eq!(format!("{:?}", Some(&token)), "Some(Token(<redacted>))");
    }

    #[test]
    fn refusals_answer_401_except_when_the_keys_cannot_be_had() {
        assert_eq!(Refusal::Missing.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(Refusal::Expired.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(Refusal::Invalid("x").status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            Refusal::KeysUnavailable.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[test]
    fn a_key_set_keeps_its_ed25519_keys_and_skips_the_rest() {
        let body = br#"{"keys":[
            {"kty":"OKP","crv":"Ed25519","kid":"a","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","alg":"EdDSA"},
            {"kty":"RSA","kid":"b","n":"AQAB","e":"AQAB"},
            {"kty":"OKP","crv":"X25519","kid":"c","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"},
            {"kty":"OKP","crv":"Ed25519","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}
        ]}"#;
        let keys = parse_jwks(body).unwrap();
        assert_eq!(keys.keys().collect::<Vec<_>>(), ["a"]);
    }

    #[test]
    fn an_answer_that_is_no_key_set_is_an_error() {
        assert!(parse_jwks(b"<html>").unwrap_err().contains("not a key set"));
        assert!(
            parse_jwks(br#"{"keys":[]}"#)
                .unwrap_err()
                .contains("no Ed25519 key")
        );
        assert!(parse_jwks(br#"{"keys":[{"kty":"RSA","kid":"b"}]}"#).is_err());
    }
}
