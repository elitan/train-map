use std::time::Duration;

use sqlx::PgPool;

/// Shared application state, available to every procedure (`ctx.state`) and
/// job handler. Keep it cheap to clone.
#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    /// HTTP client for OpenStreetMap services (connection pooling, rustls).
    pub http: reqwest::Client,
}

impl AppState {
    pub fn new(db: PgPool) -> Self {
        // reqwest uses the same `ring` crypto as the database driver
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            // OSM's usage policies ask for an identifying User-Agent
            .user_agent("train-map (https://github.com/elitan/train-map)")
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("HTTP client");
        Self { db, http }
    }
}
