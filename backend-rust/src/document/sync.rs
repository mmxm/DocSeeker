use std::collections::{HashMap, HashSet};
use std::fs;
use chrono::DateTime;
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::document::scanner::collect_document_files_recursive;
use crate::document::trash::list_trash;
use crate::pdf::indexer::compute_file_hash;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientFileEntry {
    pub filename: String,
    #[serde(default)]
    pub hash: Option<String>,
    pub mtime: i64, // secondes unix
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientTrashEntry {
    pub filename: String,
    pub deleted_at: String, // ISO-8601 / RFC3339
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncManifestRequest {
    #[serde(default)]
    pub files: Vec<ClientFileEntry>,
    #[serde(default)]
    pub trash: Vec<ClientTrashEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullItem {
    pub filename: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPlan {
    pub pull: Vec<PullItem>,
    pub push: Vec<String>,
    pub delete_local: Vec<String>,
    pub restore: Vec<String>,
}

/// Calcule le plan de synchronisation différentiel entre le client et le filesystem du serveur
pub fn compute_sync_plan(config: &Config, req: &SyncManifestRequest) -> SyncPlan {
    let mut pull = Vec::new();
    let mut push = Vec::new();
    let mut delete_local = Vec::new();
    let restore = Vec::new();

    // 1. Lister tous les fichiers actuels sur le serveur
    let server_files = collect_document_files_recursive(&config.documents_dir, &config.documents_dir);
    let mut server_files_map: HashMap<String, (std::path::PathBuf, i64)> = HashMap::new();

    for (abs_path, norm_fname) in server_files {
        let mtime = fs::metadata(&abs_path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|st| st.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        server_files_map.insert(norm_fname, (abs_path, mtime));
    }

    // 2. Lister les fichiers actuellement dans la corbeille serveur
    let trash_items = list_trash(config).unwrap_or_default();
    let mut server_trash_map: HashMap<String, i64> = HashMap::new();
    for item in &trash_items {
        let deleted_ts = DateTime::parse_from_rfc3339(&item.deleted_at)
            .map(|dt| dt.timestamp())
            .unwrap_or(0);
        server_trash_map.insert(item.original_path.clone(), deleted_ts);
    }

    let mut client_file_names = HashSet::new();

    // 3. Évaluer chaque fichier du client
    for client_file in &req.files {
        let fname = &client_file.filename;
        client_file_names.insert(fname.clone());

        if let Some((server_path, server_mtime)) = server_files_map.get(fname) {
            // Fichier présent sur les deux
            if client_file.mtime > *server_mtime + 1 {
                // Client plus récent -> push
                push.push(fname.clone());
            } else if *server_mtime > client_file.mtime + 1 {
                // Serveur plus récent -> pull
                pull.push(PullItem {
                    filename: fname.clone(),
                    reason: "server_newer".to_string(),
                });
            } else if let Some(ref client_hash) = client_file.hash {
                // Mtimes similaires, vérifier hash si fourni
                let server_hash = compute_file_hash(server_path).unwrap_or_default();
                if !server_hash.is_empty() && &server_hash != client_hash {
                    pull.push(PullItem {
                        filename: fname.clone(),
                        reason: "hash_mismatch".to_string(),
                    });
                }
            }
        } else if let Some(trash_deleted_at) = server_trash_map.get(fname) {
            // Le fichier est dans la corbeille du serveur
            if client_file.mtime > *trash_deleted_at {
                // Modification client plus récente que la mise en corbeille -> Restauration implicite / push
                push.push(fname.clone());
            } else {
                // Fichier supprimé sur le serveur après la dernière modif client -> delete local
                delete_local.push(fname.clone());
            }
        } else {
            // Absent du serveur et de sa corbeille -> c'est un nouveau fichier créé par le client
            push.push(fname.clone());
        }
    }

    // 4. Évaluer les fichiers présents sur le serveur mais absents du client
    for (server_fname, _) in &server_files_map {
        if !client_file_names.contains(server_fname) {
            // Le client n'a pas ce fichier :
            // Est-ce qu'il l'avait supprimé localement (dans sa corbeille envoyée) ?
            let client_trash_match = req.trash.iter().find(|t| &t.filename == server_fname);
            if let Some(t) = client_trash_match {
                let client_deleted_ts = DateTime::parse_from_rfc3339(&t.deleted_at)
                    .map(|dt| dt.timestamp())
                    .unwrap_or(0);
                let server_mtime = server_files_map.get(server_fname).map(|(_, mt)| *mt).unwrap_or(0);

                if client_deleted_ts > server_mtime {
                    // Le client l'a supprimé plus récemment que la modif serveur -> soft delete serveur
                    // (sera traité par soft delete ou signalement)
                    delete_local.push(server_fname.clone());
                } else {
                    // Serveur modifié après suppression client -> pull (restauration)
                    pull.push(PullItem {
                        filename: server_fname.clone(),
                        reason: "server_newer_than_trash".to_string(),
                    });
                }
            } else {
                // Nouveau fichier serveur pour le client
                pull.push(PullItem {
                    filename: server_fname.clone(),
                    reason: "new_file".to_string(),
                });
            }
        }
    }

    SyncPlan {
        pull,
        push,
        delete_local,
        restore,
    }
}
