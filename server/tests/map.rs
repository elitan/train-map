//! Integration tests for map, through the real HTTP router. These avoid the network:
//! coordinates need no place search, and bad areas are refused before any request.

use std::time::Duration;

use northstack::testing::{Client, TestDb};
use server::features::map::types::*;
use server::{AppState, MIGRATOR};

async fn setup() -> (TestDb, Client) {
    let db = northstack::testing::db(&MIGRATOR).await;
    let router =
        server::build().router(AppState::new(db.pool()), db.pool(), Duration::from_secs(30));
    (db, Client::new(router))
}

#[tokio::test]
async fn place_from_coordinates() {
    let (_db, client) = setup().await;
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

#[tokio::test]
async fn railways_refuses_bad_areas() {
    let (_db, client) = setup().await;
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
