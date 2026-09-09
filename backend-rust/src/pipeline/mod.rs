use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use rusqlite::{params, Connection};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tracing::{info, warn, error};

use crate::config::Config;
use crate::pdf::engine::PdfEngine;
use crate::pdf::indexer::index_pdf_file;

#[derive(Clone, serde::Serialize)]
pub struct CurrentJob {
    pub id: i64,
    pub filename: String,
    pub title: String,
    pub started_at: f64,
}

pub struct PipelineState {
    pub current_job: Option<CurrentJob>,
    pub queue_length: usize,
    pub enqueued_ids: HashSet<i64>,
}

pub struct IndexingPipeline {
    sender: UnboundedSender<i64>,
    state: Arc<Mutex<PipelineState>>,
    db: Arc<Mutex<Connection>>,
}

impl IndexingPipeline {
    pub fn new(
        db: Arc<Mutex<Connection>>,
        pdf_engine: Arc<PdfEngine>,
        config: Config,
    ) -> Self {
        let (sender, mut receiver): (UnboundedSender<i64>, UnboundedReceiver<i64>) = unbounded_channel();

        let state = Arc::new(Mutex::new(PipelineState {
            current_job: None,
            queue_length: 0,
            enqueued_ids: HashSet::new(),
        }));

        let worker_state = Arc::clone(&state);
        let worker_db = Arc::clone(&db);
        let worker_engine = Arc::clone(&pdf_engine);
        let worker_config = config.clone();

        // Worker thread asynchrone en arrière-plan
        tokio::spawn(async move {
            info!("[Pipeline] Worker d'indexation asynchrone démarré.");
            while let Some(doc_id) = receiver.recv().await {
                {
                    let mut s = worker_state.lock().unwrap();
                    if s.queue_length > 0 {
                        s.queue_length -= 1;
                    }
                }

                Self::process_document(
                    doc_id,
                    &worker_db,
                    &worker_engine,
                    &worker_config,
                    &worker_state,
                );

                {
                    let mut s = worker_state.lock().unwrap();
                    s.enqueued_ids.remove(&doc_id);
                    s.current_job = None;
                }
            }
        });

        let pipeline = Self { sender, state, db };
        pipeline.recover_pending();
        pipeline
    }

    pub fn enqueue(&self, doc_id: i64) {
        let mut s = self.state.lock().unwrap();
        if s.enqueued_ids.contains(&doc_id) {
            return;
        }
        s.enqueued_ids.insert(doc_id);
        s.queue_length += 1;
        let _ = self.sender.send(doc_id);
    }

    pub fn recover_pending(&self) {
        if let Ok(conn) = self.db.lock() {
            let mut stmt = match conn.prepare("SELECT id FROM documents WHERE status IN ('pending', 'indexing') ORDER BY id ASC") {
                Ok(s) => s,
                Err(_) => return,
            };

            let ids: Vec<i64> = stmt
                .query_map([], |r| r.get(0))
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default();

            for id in ids {
                self.enqueue(id);
            }
        }
    }

    pub fn retry_failed(&self) -> usize {
        if let Ok(conn) = self.db.lock() {
            let mut stmt = match conn.prepare("SELECT id FROM documents WHERE status = 'failed'") {
                Ok(s) => s,
                Err(_) => return 0,
            };

            let ids: Vec<i64> = stmt
                .query_map([], |r| r.get(0))
                .map(|rows| rows.flatten().collect())
                .unwrap_or_default();

            let _ = conn.execute(
                "UPDATE documents SET status = 'pending', error_message = NULL WHERE status = 'failed'",
                [],
            );

            for id in &ids {
                self.enqueue(*id);
            }
            ids.len()
        } else {
            0
        }
    }

    pub fn get_status(&self) -> serde_json::Value {
        let s = self.state.lock().unwrap();
        let queue_len = s.queue_length;
        let current_job = s.current_job.clone();

        let mut stats: HashMap<String, i64> = [
            ("pending".to_string(), 0),
            ("indexing".to_string(), 0),
            ("ready".to_string(), 0),
            ("failed".to_string(), 0),
            ("total".to_string(), 0),
        ]
        .into_iter()
        .collect();

        if let Ok(conn) = self.db.lock() {
            if let Ok(mut stmt) = conn.prepare("SELECT COALESCE(status, 'ready'), COUNT(*) FROM documents GROUP BY status") {
                if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))) {
                    for (st, count) in rows.flatten() {
                        stats.insert(st, count);
                    }
                }
            }
            if let Ok(mut stmt) = conn.prepare("SELECT COUNT(*) FROM documents") {
                if let Ok(total) = stmt.query_row([], |r| r.get::<_, i64>(0)) {
                    stats.insert("total".to_string(), total);
                }
            }
        }

        serde_json::json!({
            "is_processing": current_job.is_some() || queue_len > 0,
            "queue_length": queue_len,
            "current_job": current_job,
            "stats": stats
        })
    }

    fn process_document(
        doc_id: i64,
        db: &Arc<Mutex<Connection>>,
        pdf_engine: &PdfEngine,
        config: &Config,
        state: &Arc<Mutex<PipelineState>>,
    ) {
        let (filename, title) = {
            let conn = match db.lock() {
                Ok(c) => c,
                Err(_) => return,
            };

            let doc_info = conn.query_row(
                "SELECT filename, title FROM documents WHERE id = ?1",
                params![doc_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
            );

            match doc_info {
                Ok((f, t)) => (f, t.unwrap_or_default()),
                Err(_) => return,
            }
        };

        let file_path = config.documents_dir.join(&filename);
        if !file_path.exists() {
            if let Ok(conn) = db.lock() {
                let _ = conn.execute(
                    "UPDATE documents SET status = 'failed', error_message = 'Fichier physique introuvable sur le disque', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                    params![doc_id],
                );
            }
            warn!("[Pipeline] Fichier introuvable pour doc {}: {:?}", doc_id, file_path);
            return;
        }

        // Marquer comme indexing
        let now_ts = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);

        {
            let mut s = state.lock().unwrap();
            s.current_job = Some(CurrentJob {
                id: doc_id,
                filename: filename.clone(),
                title: title.clone(),
                started_at: now_ts,
            });
        }

        if let Ok(conn) = db.lock() {
            let _ = conn.execute(
                "UPDATE documents SET status = 'indexing', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![doc_id],
            );
        }

        info!("[Pipeline] Début indexation doc {} ({})...", doc_id, filename);

        // Exécution de l'indexation
        let index_res = {
            let conn = match db.lock() {
                Ok(c) => c,
                Err(e) => {
                    error!("[Pipeline] Verrouillage DB impossible : {}", e);
                    return;
                }
            };
            index_pdf_file(&conn, pdf_engine, config, &file_path, &filename, Some(&title))
        };

        if let Ok(conn) = db.lock() {
            match index_res {
                Ok(_) => {
                    let _ = conn.execute(
                        "UPDATE documents SET status = 'ready', error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                        params![doc_id],
                    );
                    info!("[Pipeline] Succès indexation doc {} ({})", doc_id, filename);
                }
                Err(err) => {
                    error!("[Pipeline] Échec indexation doc {}: {}", doc_id, err);
                    let safe_err: String = err.chars().take(500).collect();
                    let _ = conn.execute(
                        "UPDATE documents SET status = 'failed', error_message = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
                        params![safe_err, doc_id],
                    );
                }
            }
        }
    }
}
