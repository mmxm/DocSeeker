import os
import time
import logging
import threading
import queue
from typing import Optional, Dict, Any, List
from backend.database import get_db_connection
from backend.indexer import index_pdf_file, DOCUMENTS_DIR

logger = logging.getLogger("docseeker.pipeline")

class IndexingPipeline:
    """
    Pipeline d'indexation asynchrone en arrière-plan.
    Garantit que l'upload de documents PDF est instantané et non bloquant,
    tout en préservant les ressources CPU et mémoire (idéal pour Synology NAS).
    """

    def __init__(self):
        self._queue: queue.Queue = queue.Queue()
        self._worker_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._current_job: Optional[Dict[str, Any]] = None
        self._lock = threading.Lock()
        self._enqueued_ids = set()

    def start(self):
        """Démarre le worker thread en arrière-plan et récupère les tâches orphelines."""
        with self._lock:
            if self._worker_thread is not None and self._worker_thread.is_alive():
                if not self._stop_event.is_set():
                    return
                # Si le worker était en cours d'arrêt, attendre qu'il se termine avant de le relancer
                self._worker_thread.join(timeout=3.0)

            self._stop_event.clear()
            # Nettoyer les reliquats d'arrêt dans la file (ex: sentinelle None)
            with self._queue.mutex:
                self._queue.queue.clear()
            self._worker_thread = threading.Thread(target=self._worker_loop, name="IndexingPipelineWorker", daemon=True)
            self._worker_thread.start()
            logger.info("[Pipeline] Worker d'indexation démarré.")

        # Récupération automatique des documents en attente au démarrage (reprise sur redémarrage)
        self.recover_pending()

    def stop(self, wait: bool = True):
        """Arrête proprement le worker."""
        self._stop_event.set()
        self._queue.put(None)
        if wait and self._worker_thread and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=5.0)

    def recover_pending(self):
        """Ré-enfile tous les documents restés en état 'pending' ou 'indexing' dans la base."""
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("""
                SELECT id FROM documents 
                WHERE status IN ('pending', 'indexing') 
                ORDER BY id ASC
            """)
            rows = cursor.fetchall()
            conn.close()

            count = 0
            for r in rows:
                doc_id = r["id"]
                if doc_id not in self._enqueued_ids:
                    self.enqueue(doc_id)
                    count += 1
            if count > 0:
                logger.info(f"[Pipeline] Reprise de {count} document(s) non indexé(s).")
        except Exception as e:
            logger.error(f"[Pipeline] Erreur lors de la récupération des tâches en attente: {e}")

    def enqueue(self, doc_id: int):
        """Ajoute un document à la file d'attente d'indexation."""
        with self._lock:
            if doc_id in self._enqueued_ids:
                return
            self._enqueued_ids.add(doc_id)
            self._queue.put(doc_id)

    def _worker_loop(self):
        """Boucle principale du worker d'indexation séquentielle."""
        while not self._stop_event.is_set():
            try:
                doc_id = self._queue.get(timeout=1.0)
            except queue.Empty:
                continue

            if doc_id is None:  # Signal d'arrêt
                self._queue.task_done()
                break

            try:
                self._process_document(doc_id)
            except Exception as e:
                logger.error(f"[Pipeline] Erreur inattendue pour le doc {doc_id}: {e}", exc_info=True)
            finally:
                with self._lock:
                    self._enqueued_ids.discard(doc_id)
                    self._current_job = None
                self._queue.task_done()

    def _process_document(self, doc_id: int):
        """Indexe un document unique avec suivi de statut et gestion d'erreurs."""
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, filename, title FROM documents WHERE id = ?", (doc_id,))
        doc = cursor.fetchone()

        if not doc:
            conn.close()
            return

        filename = doc["filename"]
        title = doc["title"]
        file_path = os.path.join(DOCUMENTS_DIR, filename)

        if not os.path.exists(file_path):
            cursor.execute("""
                UPDATE documents 
                SET status = 'failed', error_message = 'Fichier physique introuvable sur le disque', updated_at = CURRENT_TIMESTAMP 
                WHERE id = ?
            """, (doc_id,))
            conn.commit()
            conn.close()
            logger.warning(f"[Pipeline] Fichier introuvable pour doc {doc_id} : {file_path}")
            return

        # Marquer comme en cours d'indexation
        with self._lock:
            self._current_job = {
                "id": doc_id,
                "filename": filename,
                "title": title,
                "started_at": time.time()
            }

        cursor.execute("""
            UPDATE documents 
            SET status = 'indexing', error_message = NULL, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        """, (doc_id,))
        conn.commit()
        conn.close()

        logger.info(f"[Pipeline] Début indexation doc {doc_id} ({filename})...")

        try:
            # Exécution de l'indexation complète
            index_pdf_file(file_path, filename, custom_title=title)
            
            # S'assurer que le statut est bien 'ready'
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("""
                UPDATE documents 
                SET status = 'ready', error_message = NULL, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ?
            """, (doc_id,))
            conn.commit()
            conn.close()
            logger.info(f"[Pipeline] Succès indexation doc {doc_id} ({filename})")

        except Exception as e:
            err_msg = str(e)
            logger.error(f"[Pipeline] Échec indexation doc {doc_id} ({filename}): {err_msg}")
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute("""
                    UPDATE documents 
                    SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                """, (err_msg[:500], doc_id))
                conn.commit()
                conn.close()
            except Exception:
                pass

    def get_status(self) -> Dict[str, Any]:
        """Retourne l'état courant de la file d'attente et les compteurs globaux."""
        with self._lock:
            queue_len = self._queue.qsize()
            curr = dict(self._current_job) if self._current_job else None

        stats = {"pending": 0, "indexing": 0, "ready": 0, "failed": 0, "total": 0}
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT status, COUNT(*) as count FROM documents GROUP BY status")
            for row in cursor.fetchall():
                st = row["status"] or "ready"
                if st in stats:
                    stats[st] = row["count"]
            cursor.execute("SELECT COUNT(*) as total FROM documents")
            row_total = cursor.fetchone()
            if row_total:
                stats["total"] = row_total["total"]
            conn.close()
        except Exception as e:
            logger.error(f"[Pipeline] Erreur get_status stats: {e}")

        return {
            "is_processing": curr is not None or queue_len > 0,
            "queue_length": queue_len,
            "current_job": curr,
            "stats": stats
        }

    def retry_failed(self) -> int:
        """Relance l'indexation de tous les documents en échec."""
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM documents WHERE status = 'failed'")
            failed_ids = [r["id"] for r in cursor.fetchall()]
            if failed_ids:
                cursor.execute("UPDATE documents SET status = 'pending', error_message = NULL WHERE status = 'failed'")
                conn.commit()
            conn.close()

            for fid in failed_ids:
                self.enqueue(fid)
            return len(failed_ids)
        except Exception as e:
            logger.error(f"[Pipeline] Erreur retry_failed: {e}")
            return 0

    def wait_for_idle(self, timeout: float = 10.0) -> bool:
        """Attend que la file soit complètement vidée et le travail en cours terminé (utile pour tests)."""
        start = time.time()
        while time.time() - start < timeout:
            with self._lock:
                if self._queue.qsize() == 0 and self._current_job is None:
                    return True
            time.sleep(0.05)
        return False

# Instance singleton partagée
pipeline = IndexingPipeline()
