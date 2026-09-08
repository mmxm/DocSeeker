import os
import io
import time
import uuid
import unittest
import pymupdf
from fastapi.testclient import TestClient
from backend.main import app
from backend.database import get_db_connection
from backend.pipeline import pipeline
from backend.indexer import remove_document

def create_pdf_bytes(text: str, title: str = "Test Pipeline Doc") -> bytes:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 100), f"Titre : {title}")
    page.insert_text((72, 150), text)
    pdf_data = doc.tobytes()
    doc.close()
    return pdf_data

class TestIndexingPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        pipeline.start()
        cls.cleanup_doc_ids = []
        cls.cleanup_files = []

    @classmethod
    def tearDownClass(cls):
        pipeline.wait_for_idle(timeout=5.0)
        for did in cls.cleanup_doc_ids:
            try:
                remove_document(did)
            except Exception:
                pass
        for fpath in cls.cleanup_files:
            try:
                if os.path.exists(fpath):
                    os.remove(fpath)
            except Exception:
                pass

    def setUp(self):
        pipeline.start()

    def test_pipeline_status_endpoint(self):
        """Vérifie que l'endpoint /api/pipeline/status renvoie la structure attendue."""
        res = self.client.get("/api/pipeline/status")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("is_processing", data)
        self.assertIn("queue_length", data)
        self.assertIn("stats", data)
        self.assertIn("ready", data["stats"])
        self.assertIn("pending", data["stats"])

    def test_async_upload_returns_immediately_and_indexes_in_background(self):
        """Vérifie qu'avec sync=false, l'upload est instantané (queued) et l'indexation se fait en tâche de fond."""
        pdf_bytes = create_pdf_bytes("Contenu spécifique pour tester le pipeline asynchrone xylophone.", title="Pipeline Doc Xylophone")
        unique_name = f"pipeline_async_{uuid.uuid4().hex[:8]}.pdf"
        
        # 1. Upload avec sync=false
        res = self.client.post(
            "/api/upload?sync=false",
            files={"file": (unique_name, io.BytesIO(pdf_bytes), "application/pdf")},
            data={"title": "Pipeline Doc Xylophone"}
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body.get("status"), "queued")
        
        doc = body.get("document", {})
        doc_id = doc.get("id")
        self.assertIsNotNone(doc_id)
        self.assertEqual(doc.get("status"), "pending")
        self.__class__.cleanup_doc_ids.append(doc_id)

        # 2. Vérifier l'état immédiat en base (doit être pending ou indexing)
        status_res = self.client.get(f"/api/documents/{doc_id}/status")
        self.assertEqual(status_res.status_code, 200)
        self.assertIn(status_res.json().get("status"), ["pending", "indexing", "ready"])

        # 3. Attendre que le pipeline finisse de traiter la file
        is_idle = pipeline.wait_for_idle(timeout=8.0)
        self.assertTrue(is_idle, "Le pipeline a mis trop de temps à traiter le document.")

        # 4. Vérifier que le document est désormais 'ready'
        doc_status = self.client.get(f"/api/documents/{doc_id}/status").json()
        self.assertEqual(doc_status.get("status"), "ready")
        self.assertGreater(doc_status.get("total_pages", 0), 0)

        # 5. Vérifier qu'il est désormais trouvable dans la recherche plein texte
        search_res = self.client.get("/api/search?q=xylophone").json()
        self.assertGreater(search_res.get("total_documents", 0), 0)
        found_ids = [d["id"] for d in search_res.get("results", [])]
        self.assertIn(doc_id, found_ids)

    def test_pipeline_recovers_pending_documents(self):
        """Vérifie que recover_pending détecte et ré-enfile les documents orphelins."""
        unique_name = f"orphan_{uuid.uuid4().hex[:8]}.pdf"
        pdf_bytes = create_pdf_bytes("Contenu pour reprise après interruption.", title="Doc Orphelin")
        doc_path = os.path.join("data", "documents", unique_name)
        with open(doc_path, "wb") as f:
            f.write(pdf_bytes)
        self.__class__.cleanup_files.append(doc_path)

        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO documents (filename, title, file_hash, status, total_pages, file_size)
            VALUES (?, 'Doc Orphelin', ?, 'pending', 0, 1024)
        """, (unique_name, f"fakehash_{uuid.uuid4().hex[:16]}"))
        orphan_id = cursor.lastrowid
        conn.commit()
        conn.close()
        self.__class__.cleanup_doc_ids.append(orphan_id)

        # Déclencher la récupération
        pipeline.recover_pending()
        pipeline.wait_for_idle(timeout=8.0)

        # Vérifier que le document orphelin a bien été indexé
        res = self.client.get(f"/api/documents/{orphan_id}/status").json()
        self.assertEqual(res.get("status"), "ready")
        self.assertGreater(res.get("total_pages", 0), 0)

    def test_pipeline_handles_missing_file_gracefully(self):
        """Vérifie que si un fichier physique est absent, le document passe en 'failed' sans bloquer le pipeline."""
        unique_ghost_name = f"ghost_{uuid.uuid4().hex[:8]}.pdf"
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO documents (filename, title, file_hash, status, total_pages, file_size)
            VALUES (?, 'Doc Fantôme', ?, 'pending', 0, 1024)
        """, (unique_ghost_name, f"fakehash_{uuid.uuid4().hex[:16]}"))
        ghost_id = cursor.lastrowid
        conn.commit()
        conn.close()
        self.__class__.cleanup_doc_ids.append(ghost_id)

        pipeline.enqueue(ghost_id)
        pipeline.wait_for_idle(timeout=5.0)

        # Le document fantôme doit être en 'failed' avec un message d'erreur
        res = self.client.get(f"/api/documents/{ghost_id}/status").json()
        self.assertEqual(res.get("status"), "failed")
        self.assertIsNotNone(res.get("error_message"))

        # Vérifier que retry_failed ré-enfile les documents en échec
        retry_res = self.client.post("/api/pipeline/retry-failed")
        self.assertEqual(retry_res.status_code, 200)
        self.assertGreaterEqual(retry_res.json().get("requeued_count", 0), 1)

    def test_batch_async_upload_multiple_files(self):
        """Vérifie l'importation massive asynchrone : upload rapide de 3 documents traités séquentiellement par le pipeline."""
        batch_ids = []
        for i in range(3):
            unique_name = f"batch_{uuid.uuid4().hex[:8]}_{i}.pdf"
            pdf_bytes = create_pdf_bytes(f"Texte du document de lot numéro {i} pour recherche zèbre.", title=f"Doc Lot Async {i}")
            res = self.client.post(
                "/api/upload?sync=false",
                files={"file": (unique_name, io.BytesIO(pdf_bytes), "application/pdf")},
                data={"title": f"Doc Lot Async {i}"}
            )
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertEqual(data.get("status"), "queued")
            doc_id = data.get("document", {}).get("id")
            self.assertIsNotNone(doc_id)
            batch_ids.append(doc_id)
            self.__class__.cleanup_doc_ids.append(doc_id)

        # Attente du vidage du pipeline
        idle = pipeline.wait_for_idle(timeout=10.0)
        self.assertTrue(idle, "Le pipeline n'a pas fini de traiter le lot.")

        # Vérifier que tous les 3 documents sont devenus 'ready'
        for bid in batch_ids:
            st = self.client.get(f"/api/documents/{bid}/status").json()
            self.assertEqual(st.get("status"), "ready")

        # Vérifier que le contenu est trouvable dans la recherche
        search_res = self.client.get("/api/search?q=zèbre").json()
        self.assertGreaterEqual(search_res.get("total_documents", 0), 1)

    def test_documents_list_returns_status(self):
        """Vérifie que /api/documents expose bien le champ status pour chaque document."""
        res = self.client.get("/api/documents")
        self.assertEqual(res.status_code, 200)
        docs = res.json().get("documents", [])
        self.assertGreater(len(docs), 0)
        for d in docs:
            self.assertIn("status", d)
            self.assertIn(d["status"], ["pending", "indexing", "ready", "failed"])

    def test_check_hash_existing_document(self):
        """Vérifie que /api/check-hash identifie correctement un document déjà présent."""
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id, filename, title, file_hash, created_at FROM documents WHERE file_hash IS NOT NULL LIMIT 1")
        row = cursor.fetchone()
        conn.close()

        self.assertIsNotNone(row, "Un document avec file_hash doit exister dans la base.")
        doc_hash = row["file_hash"]

        res = self.client.get(f"/api/check-hash/{doc_hash}")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["exists"])
        self.assertIsNotNone(data["existing_doc"])
        self.assertEqual(data["existing_doc"]["id"], row["id"])
        self.assertEqual(data["existing_doc"]["filename"], row["filename"])
        self.assertEqual(data["existing_doc"]["title"], row["title"])

    def test_check_hash_case_insensitive(self):
        """Vérifie que la comparaison du hash hexadécimal est insensible à la casse (majuscules acceptées)."""
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT file_hash FROM documents WHERE file_hash IS NOT NULL LIMIT 1")
        row = cursor.fetchone()
        conn.close()

        doc_hash_upper = row["file_hash"].upper()
        res = self.client.get(f"/api/check-hash/{doc_hash_upper}")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.json()["exists"])

    def test_check_hash_non_existent(self):
        """Vérifie que /api/check-hash renvoie exists=False pour une empreinte inconnue."""
        fake_hash = "0" * 64
        res = self.client.get(f"/api/check-hash/{fake_hash}")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertFalse(data["exists"])
        self.assertIsNone(data["existing_doc"])

    def test_check_hash_invalid_format(self):
        """Vérifie que les formats de hash invalides sont rejetés avec HTTP 400."""
        # Trop court
        res_short = self.client.get("/api/check-hash/abcd1234")
        self.assertEqual(res_short.status_code, 400)

        # Caractères non hexadécimaux
        res_invalid_char = self.client.get(f"/api/check-hash/{'z' * 64}")
        self.assertEqual(res_invalid_char.status_code, 400)

    def test_pre_upload_hash_check_avoids_redundant_upload(self):
        """Simule le comportement du client : pré-calcul SHA-256, test d'existence, puis évitement de l'upload."""
        import hashlib
        unique_name = f"anti_doublon_{uuid.uuid4().hex[:8]}.pdf"
        pdf_bytes = create_pdf_bytes("Document pour test d'évitement d'upload inutile.", title="Doc Anti Doublon Client")
        file_sha256 = hashlib.sha256(pdf_bytes).hexdigest()

        # 1. Avant upload, le document n'existe pas en base
        check_before = self.client.get(f"/api/check-hash/{file_sha256}").json()
        self.assertFalse(check_before["exists"])

        # 2. Upload initial du document
        up_res = self.client.post(
            "/api/upload?sync=true",
            files={"file": (unique_name, io.BytesIO(pdf_bytes), "application/pdf")},
            data={"title": "Doc Anti Doublon Client"}
        )
        self.assertEqual(up_res.status_code, 200)
        doc_id = up_res.json()["document"]["id"]
        self.__class__.cleanup_doc_ids.append(doc_id)

        # 3. Nouvelle tentative : le client pré-calcule le hash avant d'uploader
        check_after = self.client.get(f"/api/check-hash/{file_sha256}").json()
        self.assertTrue(check_after["exists"], "Le hash doit maintenant être détecté comme existant.")
        self.assertEqual(check_after["existing_doc"]["id"], doc_id)
        # Le client évite d'appeler POST /api/upload !

if __name__ == "__main__":
    unittest.main()
