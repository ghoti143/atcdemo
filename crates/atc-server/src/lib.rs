//! The real-time server: simulator, conflict detector and the WebSocket.

pub mod config;
pub mod hub;
pub mod sim;
pub mod world;

use std::time::Duration;

use axum::{Router, extract::State, http::StatusCode, routing::get};
use sqlx::postgres::{PgPool, PgPoolOptions};

/// How long `/healthz` waits for the database before reporting it unreachable.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

/// What every request handler can reach.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub hub: hub::Hub,
    /// The only origin socket connections may come from.
    pub allowed_origin: String,
    pub auth: config::Auth,
}

/// Creates the database pool without connecting. The first query opens the
/// first connection, so the server starts, and `/healthz` can answer, while
/// Postgres is still down.
pub fn connect_lazy(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(HEALTH_TIMEOUT)
        .connect_lazy(database_url)
}

/// Builds the HTTP router.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(hub::upgrade))
        .with_state(state)
}

/// 200 when a query reaches the database, 503 when it does not.
async fn healthz(State(state): State<AppState>) -> (StatusCode, &'static str) {
    let ping = sqlx::query("SELECT 1").execute(&state.db);
    match tokio::time::timeout(HEALTH_TIMEOUT, ping).await {
        Ok(Ok(_)) => (StatusCode::OK, "ok"),
        Ok(Err(error)) => {
            eprintln!("healthz: database unreachable: {error}");
            (StatusCode::SERVICE_UNAVAILABLE, "database unreachable")
        }
        Err(_) => {
            eprintln!("healthz: database did not answer within {HEALTH_TIMEOUT:?}");
            (StatusCode::SERVICE_UNAVAILABLE, "database unreachable")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    async fn healthz_status(database_url: &str) -> StatusCode {
        let sim = hub::SimInfo {
            multiplier: 1,
            window_s: 1,
        };
        let tracks = sim::track::Tracks::new(Default::default());
        let state = AppState {
            db: connect_lazy(database_url).unwrap(),
            hub: hub::Hub::spawn(world::WorldWriter::new().reader(), sim, tracks),
            allowed_origin: "http://localhost:3000".to_owned(),
            auth: config::Auth::Off,
        };
        app(state)
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn healthz_returns_503_when_the_database_is_unreachable() {
        // Port 9 is the discard service; nothing listens there.
        let status = healthz_status("postgres://atc:atc@127.0.0.1:9/atc").await;

        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    /// Needs a real Postgres. Without `DATABASE_URL` the test passes without
    /// checking anything, so `cargo test` works on a machine with no
    /// database; CI always sets it.
    #[tokio::test]
    async fn healthz_returns_200_when_the_database_answers() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipped: DATABASE_URL is not set");
            return;
        };

        assert_eq!(healthz_status(&database_url).await, StatusCode::OK);
    }
}
