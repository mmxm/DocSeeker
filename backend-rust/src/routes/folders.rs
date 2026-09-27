use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::AppState;

#[derive(Serialize)]
pub struct FolderItem {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub color: String,
    pub created_at: String,
    pub doc_count: i64,
}

#[derive(Deserialize)]
pub struct FolderListQuery {
    pub parent_id: Option<String>,
}

#[derive(Deserialize)]
pub struct CreateFolderPayload {
    pub name: String,
    pub parent_id: Option<i64>,
    pub color: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateFolderPayload {
    pub name: Option<String>,
    pub color: Option<String>,
}

pub async fn list_folders(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FolderListQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let sql = match query.parent_id.as_deref() {
        Some("root") => {
            "SELECT f.id, f.name, f.parent_id, f.color, f.created_at, COUNT(d.id) as doc_count \
             FROM folders f LEFT JOIN documents d ON d.folder_id = f.id \
             WHERE f.parent_id IS NULL GROUP BY f.id ORDER BY f.name ASC"
        }
        Some(pid) if pid.parse::<i64>().is_ok() => {
            "SELECT f.id, f.name, f.parent_id, f.color, f.created_at, COUNT(d.id) as doc_count \
             FROM folders f LEFT JOIN documents d ON d.folder_id = f.id \
             WHERE f.parent_id = ?1 GROUP BY f.id ORDER BY f.name ASC"
        }
        _ => {
            "SELECT f.id, f.name, f.parent_id, f.color, f.created_at, COUNT(d.id) as doc_count \
             FROM folders f LEFT JOIN documents d ON d.folder_id = f.id \
             GROUP BY f.id ORDER BY f.name ASC"
        }
    };

    let mut stmt = conn.prepare(sql).map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
    })?;

    let rows = if let Some(pid) = query.parent_id.as_deref() {
        if let Ok(id_num) = pid.parse::<i64>() {
            stmt.query_map(params![id_num], map_folder_row)
        } else {
            stmt.query_map([], map_folder_row)
        }
    } else {
        stmt.query_map([], map_folder_row)
    };

    let folders: Vec<FolderItem> = rows
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response())?
        .flatten()
        .collect();

    Ok(Json(serde_json::json!({
        "folders": folders
    })))
}

fn map_folder_row(row: &rusqlite::Row) -> rusqlite::Result<FolderItem> {
    Ok(FolderItem {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        color: row.get::<_, Option<String>>(3)?.unwrap_or_else(|| "#3b82f6".to_string()),
        created_at: row.get(4)?,
        doc_count: row.get(5)?,
    })
}

use std::path::PathBuf;

/// Calcule le chemin relatif d'un dossier dans l'arborescence (ex: "Collèges/Gynécologie")
pub fn get_folder_relative_path(conn: &rusqlite::Connection, folder_id: i64) -> Option<PathBuf> {
    let mut current_id = folder_id;
    let mut parts = Vec::new();
    let mut visited = std::collections::HashSet::new();

    while current_id > 0 && visited.insert(current_id) {
        let parent_info: Result<(String, Option<i64>), _> = conn.query_row(
            "SELECT name, parent_id FROM folders WHERE id = ?1",
            params![current_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        );
        match parent_info {
            Ok((name, parent_opt)) => {
                parts.push(name);
                match parent_opt {
                    Some(pid) => current_id = pid,
                    None => break,
                }
            }
            Err(_) => break,
        }
    }

    if parts.is_empty() {
        None
    } else {
        parts.reverse();
        let mut path = PathBuf::new();
        for p in parts {
            path.push(p);
        }
        Some(path)
    }
}

pub async fn create_folder(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<CreateFolderPayload>,
) -> Result<Json<serde_json::Value>, Response> {
    if payload.name.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Le nom du dossier ne peut pas être vide"}))).into_response());
    }

    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let color = payload.color.unwrap_or_else(|| "#3b82f6".to_string());
    conn.execute(
        "INSERT INTO folders (name, parent_id, color) VALUES (?1, ?2, ?3)",
        params![payload.name.trim(), payload.parent_id, color],
    ).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response())?;

    let id = conn.last_insert_rowid();

    // Création physique du dossier correspondant sur le système de fichiers
    if let Some(rel) = get_folder_relative_path(&conn, id) {
        let abs_dir = state.config.documents_dir.join(rel);
        let _ = std::fs::create_dir_all(abs_dir);
    }

    Ok(Json(serde_json::json!({
        "id": id,
        "name": payload.name.trim(),
        "parent_id": payload.parent_id,
        "color": color
    })))
}

pub async fn update_folder(
    State(state): State<Arc<AppState>>,
    Path(folder_id): Path<i64>,
    Json(payload): Json<UpdateFolderPayload>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    if let Some(ref name) = payload.name {
        let clean_name = name.trim();
        if !clean_name.is_empty() {
            let old_rel = get_folder_relative_path(&conn, folder_id);
            conn.execute(
                "UPDATE folders SET name = ?1 WHERE id = ?2",
                params![clean_name, folder_id],
            ).ok();
            let new_rel = get_folder_relative_path(&conn, folder_id);

            // Renommage physique du dossier sur le disque
            if let (Some(old_p), Some(new_p)) = (old_rel, new_rel) {
                let old_abs = state.config.documents_dir.join(&old_p);
                let new_abs = state.config.documents_dir.join(&new_p);
                if old_abs.exists() {
                    let _ = std::fs::rename(&old_abs, &new_abs);
                }
                let old_prefix = old_p.to_string_lossy().to_string();
                let new_prefix = new_p.to_string_lossy().to_string();
                let _ = conn.execute(
                    "UPDATE documents SET filename = ?1 || substr(filename, length(?2) + 1) WHERE folder_id = ?3 AND filename LIKE ?2 || '/%'",
                    params![new_prefix, old_prefix, folder_id],
                );
            }
        }
    }

    if let Some(ref color) = payload.color {
        conn.execute(
            "UPDATE folders SET color = ?1 WHERE id = ?2",
            params![color.trim(), folder_id],
        ).ok();
    }

    Ok(Json(serde_json::json!({"status": "ok"})))
}

pub async fn delete_folder(
    State(state): State<Arc<AppState>>,
    Path(folder_id): Path<i64>,
) -> Result<Json<serde_json::Value>, Response> {
    let conn = state.db.get().map_err(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "DB lock error"}))).into_response()
    })?;

    let rel = get_folder_relative_path(&conn, folder_id);
    conn.execute("DELETE FROM folders WHERE id = ?1", params![folder_id])
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response())?;

    // Suppression physique du sous-dossier correspondant sur le disque
    if let Some(rel_path) = rel {
        let abs_dir = state.config.documents_dir.join(rel_path);
        if abs_dir.exists() {
            let _ = std::fs::remove_dir_all(abs_dir);
        }
    }

    Ok(Json(serde_json::json!({"status": "ok"})))
}
