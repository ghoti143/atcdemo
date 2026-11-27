//! For tests of token verification: two signing keys, tokens made with
//! them, and a stand-in for the web app's public-keys URL.
//!
//! Shared by this crate's tests and `atc-cli`'s, which include the file by
//! path, so not every test uses every item.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// The web app's public URL in these tests: the issuer and the audience of
/// a good token, and the allowed origin.
pub const ISSUER: &str = "http://localhost:3000";

/// An Ed25519 key pair with the id it is published under.
#[derive(Debug, Clone, Copy)]
pub struct SigningKey {
    pub id: &'static str,
    /// The 32-byte private seed.
    seed: [u8; 32],
    /// The public key as a JWK carries it: base64url, no padding.
    pub x: &'static str,
}

/// The first two test vectors of RFC 8032, section 7.1.
pub const KEY_A: SigningKey = SigningKey {
    id: "key-a",
    seed: [
        0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c,
        0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae,
        0x7f, 0x60,
    ],
    x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
};
pub const KEY_B: SigningKey = SigningKey {
    id: "key-b",
    seed: [
        0x4c, 0xcd, 0x08, 0x9b, 0x28, 0xff, 0x96, 0xda, 0x9d, 0xb6, 0xc3, 0x46, 0xec, 0x11, 0x4e,
        0x0f, 0x5b, 0x8a, 0x31, 0x9f, 0x35, 0xab, 0xa6, 0x24, 0xda, 0x8c, 0xf6, 0xed, 0x4f, 0xb8,
        0xa6, 0xfb,
    ],
    x: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
};

impl SigningKey {
    /// The same key published under another id.
    pub fn with_id(self, id: &'static str) -> SigningKey {
        SigningKey { id, ..self }
    }

    /// The private key as PKCS#8: a fixed prefix and the seed.
    fn pkcs8(&self) -> Vec<u8> {
        let mut der = vec![
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
            0x04, 0x20,
        ];
        der.extend_from_slice(&self.seed);
        der
    }

    /// The key as the web app publishes it.
    pub fn jwk(&self) -> Value {
        json!({ "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "kid": self.id, "x": self.x })
    }

    /// Signs `claims` as the web app would: EdDSA, naming this key.
    pub fn sign(&self, claims: &Value) -> String {
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(self.id.to_owned());
        self.sign_with(&header, claims)
    }

    /// Signs `claims` under a header of the test's choosing.
    pub fn sign_with(&self, header: &Header, claims: &Value) -> String {
        jsonwebtoken::encode(header, claims, &EncodingKey::from_ed_der(&self.pkcs8())).unwrap()
    }
}

/// Seconds since the epoch, now.
pub fn now() -> i64 {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    i64::try_from(since.as_secs()).unwrap()
}

/// The claims of a token the web app would issue now for `role`, good for
/// five minutes.
pub fn claims(role: &str) -> Value {
    json!({
        "sub": "user-1",
        "role": role,
        "iat": now(),
        "exp": now() + 300,
        "iss": ISSUER,
        "aud": ISSUER,
    })
}

/// `claims`, with the fields of `changes` set and those it gives as null
/// removed.
pub fn claims_with(role: &str, changes: Value) -> Value {
    let mut claims = claims(role);
    for (name, value) in changes.as_object().unwrap() {
        if value.is_null() {
            claims.as_object_mut().unwrap().remove(name);
        } else {
            claims[name] = value.clone();
        }
    }
    claims
}

/// What the stand-in keys URL answers with.
struct Answer {
    status: StatusCode,
    body: String,
}

/// A stand-in for the web app's public-keys URL, on a port of its own.
#[derive(Clone)]
pub struct KeysServer {
    pub url: String,
    addr: SocketAddr,
    answer: Arc<Mutex<Answer>>,
    requests: Arc<AtomicUsize>,
}

impl KeysServer {
    /// Starts one that publishes `keys`.
    pub async fn start(keys: &[SigningKey]) -> KeysServer {
        let answer = Arc::new(Mutex::new(Answer {
            status: StatusCode::OK,
            body: String::new(),
        }));
        let requests = Arc::new(AtomicUsize::new(0));
        let app = axum::Router::new()
            .route("/api/auth/jwks", get(serve_keys))
            .with_state((answer.clone(), requests.clone()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        let server = KeysServer {
            url: format!("http://{addr}/api/auth/jwks"),
            addr,
            answer,
            requests,
        };
        server.publish(keys);
        server
    }

    /// Replaces the keys published, as a rotation would.
    pub fn publish(&self, keys: &[SigningKey]) {
        let keys: Vec<Value> = keys.iter().map(SigningKey::jwk).collect();
        self.answer_with(StatusCode::OK, &json!({ "keys": keys }).to_string());
    }

    /// Makes every request from now on get this answer.
    pub fn answer_with(&self, status: StatusCode, body: &str) {
        *self.answer.lock().unwrap() = Answer {
            status,
            body: body.to_owned(),
        };
    }

    /// How many times the keys have been asked for.
    pub fn requests(&self) -> usize {
        self.requests.load(Ordering::SeqCst)
    }
}

async fn serve_keys(
    State((answer, requests)): State<(Arc<Mutex<Answer>>, Arc<AtomicUsize>)>,
) -> (StatusCode, String) {
    requests.fetch_add(1, Ordering::SeqCst);
    let answer = answer.lock().unwrap();
    (answer.status, answer.body.clone())
}

/// A URL nothing is listening at.
pub async fn dead_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);
    format!("http://{addr}/api/auth/jwks")
}
