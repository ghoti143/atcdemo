//! Token verification on its own: the verifier against a stand-in for the
//! web app's public-keys URL, with tokens signed here.

mod support;

use std::sync::Arc;
use std::time::Duration;

use atc_server::auth::{Refusal, Token, Verifier};
use atc_server::hub::Role;
use axum::http::StatusCode;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::json;
use support::{ISSUER, KEY_A, KEY_B, KeysServer, claims, claims_with, now};

/// A verifier that may ask for the keys again at once.
fn verifier(keys: &KeysServer) -> Verifier {
    Verifier::with_refetch_interval(&keys.url, ISSUER, Duration::ZERO)
}

async fn verify(verifier: &Verifier, token: &str) -> Result<(String, Role), Refusal> {
    let user = verifier.verify(&Token::new(token)).await?;
    Ok((user.id, user.role))
}

fn invalid(result: Result<(String, Role), Refusal>) -> &'static str {
    match result {
        Err(Refusal::Invalid(why)) => why,
        other => panic!("expected the token to be invalid, got {other:?}"),
    }
}

#[tokio::test]
async fn a_good_token_gives_the_user_and_the_role() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);

    let viewer = verify(&verifier, &KEY_A.sign(&claims("viewer"))).await;
    assert_eq!(viewer, Ok(("user-1".to_owned(), Role::Viewer)));

    let token = KEY_A.sign(&claims_with("controller", json!({ "sub": "user-2" })));
    let controller = verify(&verifier, &token).await;
    assert_eq!(controller, Ok(("user-2".to_owned(), Role::Controller)));
}

#[tokio::test]
async fn an_expired_token_is_refused() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);

    let token = KEY_A.sign(&claims_with("viewer", json!({ "exp": now() - 120 })));
    assert_eq!(verify(&verifier, &token).await, Err(Refusal::Expired));

    // Clocks may disagree by half a minute.
    let token = KEY_A.sign(&claims_with("viewer", json!({ "exp": now() - 10 })));
    assert!(verify(&verifier, &token).await.is_ok());
}

#[tokio::test]
async fn a_token_signed_by_another_key_is_refused() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);

    // Signed by a key the web app does not publish, claiming to be its key.
    let forged = KEY_B.with_id(KEY_A.id).sign(&claims("controller"));
    assert_eq!(
        invalid(verify(&verifier, &forged).await),
        "the token's signature is wrong"
    );

    // Signed by an unpublished key under its own id.
    let unknown = KEY_B.sign(&claims("controller"));
    assert_eq!(
        invalid(verify(&verifier, &unknown).await),
        "the token is signed by an unknown key"
    );
}

#[tokio::test]
async fn a_token_altered_after_signing_is_refused() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);

    let token = KEY_A.sign(&claims("viewer"));
    let promoted = KEY_A.sign(&claims("controller"));
    let (header, rest) = token.split_once('.').unwrap();
    let (_, signature) = rest.split_once('.').unwrap();
    let payload = promoted.split('.').nth(1).unwrap();
    // The viewer's signature on the controller's claims.
    let altered = format!("{header}.{payload}.{signature}");

    assert_eq!(
        invalid(verify(&verifier, &altered).await),
        "the token's signature is wrong"
    );
}

#[tokio::test]
async fn only_eddsa_is_accepted() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);

    // The classic confusion: HMAC with the public key as the secret.
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some(KEY_A.id.to_owned());
    let secret = EncodingKey::from_secret(KEY_A.x.as_bytes()).unwrap();
    let confused = jsonwebtoken::encode(&header, &claims("controller"), &secret).unwrap();
    assert_eq!(
        invalid(verify(&verifier, &confused).await),
        "the token is not signed with EdDSA"
    );

    // An unsigned token: {"alg":"none","kid":"key-a"} and no signature.
    let payload = KEY_A.sign(&claims("controller"));
    let payload = payload.split('.').nth(1).unwrap();
    let unsigned = format!("eyJhbGciOiJub25lIiwia2lkIjoia2V5LWEifQ.{payload}.");
    assert_eq!(
        invalid(verify(&verifier, &unsigned).await),
        "the token is not a signed token"
    );
}

#[tokio::test]
async fn a_token_from_or_for_someone_else_is_refused() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);
    let refused = async |changes| {
        let token = KEY_A.sign(&claims_with("viewer", changes));
        invalid(verify(&verifier, &token).await)
    };

    assert_eq!(
        refused(json!({ "iss": "http://evil.example" })).await,
        "the token is from another issuer"
    );
    assert_eq!(
        refused(json!({ "aud": "http://evil.example" })).await,
        "the token is for another audience"
    );
    // A trailing slash is another issuer: the comparison is exact.
    assert_eq!(
        refused(json!({ "iss": format!("{ISSUER}/") })).await,
        "the token is from another issuer"
    );
}

#[tokio::test]
async fn a_token_missing_a_claim_is_refused() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);

    for claim in ["exp", "iss", "aud", "sub", "role"] {
        let token = KEY_A.sign(&claims_with("viewer", json!({ claim: null })));
        let result = verify(&verifier, &token).await;
        assert!(
            matches!(result, Err(Refusal::Invalid(_))),
            "without {claim}: {result:?}"
        );
    }
    let token = KEY_A.sign(&claims_with("viewer", json!({ "sub": "" })));
    assert_eq!(
        invalid(verify(&verifier, &token).await),
        "the token names no user"
    );
}

#[tokio::test]
async fn an_unknown_role_is_refused_not_guessed() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);

    for role in ["admin", "Controller", ""] {
        let token = KEY_A.sign(&claims(role));
        assert_eq!(
            invalid(verify(&verifier, &token).await),
            "the token names an unknown role"
        );
    }
}

#[tokio::test]
async fn text_that_is_not_a_token_is_refused() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);

    for text in ["", "not-a-token", "a.b.c", "...."] {
        assert!(matches!(
            verify(&verifier, text).await,
            Err(Refusal::Invalid(_))
        ));
    }
    // A header with no key id.
    let token = KEY_A.sign_with(&Header::new(Algorithm::EdDSA), &claims("viewer"));
    assert_eq!(
        invalid(verify(&verifier, &token).await),
        "the token does not name its key"
    );
    // None of that needed the keys.
    assert_eq!(keys.requests(), 0);
}

#[tokio::test]
async fn the_keys_are_fetched_once_and_kept() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = Arc::new(verifier(&keys));
    let token = KEY_A.sign(&claims("viewer"));

    // A burst of first connections makes one request.
    let burst: Vec<_> = (0..20)
        .map(|_| {
            let (verifier, token) = (verifier.clone(), token.clone());
            tokio::spawn(async move { verifier.verify(&Token::new(token)).await.is_ok() })
        })
        .collect();
    for task in burst {
        assert!(task.await.unwrap());
    }
    for _ in 0..5 {
        assert!(verify(&verifier, &token).await.is_ok());
    }
    assert_eq!(keys.requests(), 1);
}

#[tokio::test]
async fn an_unknown_key_id_fetches_the_keys_again() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);
    assert!(
        verify(&verifier, &KEY_A.sign(&claims("viewer")))
            .await
            .is_ok()
    );
    assert_eq!(keys.requests(), 1);

    // The web app rotates its key.
    keys.publish(&[KEY_B]);
    assert!(
        verify(&verifier, &KEY_B.sign(&claims("viewer")))
            .await
            .is_ok()
    );
    assert_eq!(keys.requests(), 2);

    // The old key is no longer published, so its tokens are no longer good.
    assert_eq!(
        invalid(verify(&verifier, &KEY_A.sign(&claims("viewer"))).await),
        "the token is signed by an unknown key"
    );
}

#[tokio::test]
async fn unknown_key_ids_cannot_make_the_server_ask_without_limit() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = Verifier::with_refetch_interval(&keys.url, ISSUER, Duration::from_secs(60));
    assert!(
        verify(&verifier, &KEY_A.sign(&claims("viewer")))
            .await
            .is_ok()
    );

    for _ in 0..10 {
        let unknown = KEY_B.sign(&claims("viewer"));
        assert_eq!(
            invalid(verify(&verifier, &unknown).await),
            "the token is signed by an unknown key"
        );
    }
    assert_eq!(keys.requests(), 1);
    // And the key it has still works.
    assert!(
        verify(&verifier, &KEY_A.sign(&claims("viewer")))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn with_no_keys_to_be_had_nothing_is_verified_and_the_answer_is_try_again() {
    let verifier =
        Verifier::with_refetch_interval(support::dead_url().await, ISSUER, Duration::ZERO);

    let result = verify(&verifier, &KEY_A.sign(&claims("controller"))).await;
    assert_eq!(result, Err(Refusal::KeysUnavailable));
    assert_eq!(
        Refusal::KeysUnavailable.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
}

#[tokio::test]
async fn the_keys_url_answering_wrongly_is_the_same_as_no_keys() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);
    let token = KEY_A.sign(&claims("viewer"));

    for (status, body) in [
        (StatusCode::NOT_FOUND, "not found"),
        (StatusCode::OK, "<html>sign in</html>"),
        (StatusCode::OK, r#"{"keys":[]}"#),
        // A key too short to be one.
        (
            StatusCode::OK,
            r#"{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"key-a","x":"AAAA"}]}"#,
        ),
    ] {
        keys.answer_with(status, body);
        assert_eq!(
            verify(&verifier, &token).await,
            Err(Refusal::KeysUnavailable),
            "{status} {body}"
        );
    }

    // Once the web app is back, so is verification.
    keys.publish(&[KEY_A]);
    assert!(verify(&verifier, &token).await.is_ok());
}

#[tokio::test]
async fn keys_already_held_survive_the_web_app_going_away() {
    let keys = KeysServer::start(&[KEY_A]).await;
    let verifier = verifier(&keys);
    let token = KEY_A.sign(&claims("viewer"));
    assert!(verify(&verifier, &token).await.is_ok());

    keys.answer_with(StatusCode::INTERNAL_SERVER_ERROR, "down");
    // A token naming an unknown key makes it ask, and fail.
    let unknown = KEY_B.sign(&claims("viewer"));
    assert_eq!(
        verify(&verifier, &unknown).await,
        Err(Refusal::KeysUnavailable)
    );
    // The key it had is still good.
    assert!(verify(&verifier, &token).await.is_ok());
}
