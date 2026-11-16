//! All SQL for map: the cache of OpenStreetMap answers.

use serde::{Serialize, de::DeserializeOwned};
use sqlx::SqliteExecutor;

/// A cached answer, if there is one and it still has the expected shape.
pub async fn cached<'e, T: DeserializeOwned>(
    db: impl SqliteExecutor<'e>,
    key: &str,
) -> sqlx::Result<Option<T>> {
    let row = sqlx::query_scalar!("SELECT data FROM osm_cache WHERE key = $1", key)
        .fetch_optional(db)
        .await?;
    Ok(row.and_then(|data| serde_json::from_value(data).ok()))
}

pub async fn store<'e, T: Serialize>(
    db: impl SqliteExecutor<'e>,
    key: &str,
    data: &T,
) -> sqlx::Result<()> {
    let data = serde_json::to_value(data).map_err(|e| sqlx::Error::Encode(Box::new(e)))?;
    sqlx::query!(
        "INSERT INTO osm_cache (key, data) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET data = excluded.data,
           fetched_at = strftime('%Y-%m-%dT%H:%M:%f+00:00')",
        key,
        data
    )
    .execute(db)
    .await?;
    Ok(())
}
