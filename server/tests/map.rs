//! Integration tests for map, through the real HTTP router. These avoid the network:
//! coordinates need no place search, and bad areas are refused before any request.

use std::time::Duration;

use northstack::testing::Client;
use server::features::map::types::*;
use server::{AppState, MIGRATOR};
use sqlx::PgPool;

async fn setup(pool: &PgPool) -> Client {
    northstack::migrate(pool, &MIGRATOR).await.unwrap();
    let router = server::build().router(
        AppState::new(pool.clone()),
        pool.clone(),
        Duration::from_secs(30),
    );
    Client::new(router)
}

#[sqlx::test(migrations = false)]
async fn place_from_coordinates(pool: PgPool) {
    let client = setup(&pool).await;
    let p: Place = client
        .call(
            "map.place",
            &PlaceInput {
                q: "55.7058, 13.187".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!((p.lat, p.lon), (55.7058, 13.187));
}

#[sqlx::test(migrations = false)]
async fn railways_refuses_bad_areas(pool: PgPool) {
    let client = setup(&pool).await;
    let too_big = RailwaysInput {
        s: 55.0,
        w: 13.0,
        n: 56.0,
        e: 14.0,
    };
    let err = client
        .call::<_, Vec<RailLine>>("map.railways", &too_big)
        .await
        .unwrap_err();
    assert_eq!(err.code, northstack::ErrorCode::BadRequest);
    let flipped = RailwaysInput {
        s: 55.1,
        w: 13.0,
        n: 55.0,
        e: 13.1,
    };
    assert!(
        client
            .call::<_, Vec<RailLine>>("map.railways", &flipped)
            .await
            .is_err()
    );
}
