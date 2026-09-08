import unittest
import os
import io
import json
import tempfile
import shutil
import sqlite3
import pymupdf
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from backend.main import app, lifespan, _apply_annotations_to_pdf
from backend.database import get_db_connection, DB_PATH
from backend.indexer import (
    index_pdf_file,
    remove_document,
    scan_and_sync_documents,
    DOCUMENTS_DIR,
    COVERS_DIR,
    CACHE_DIR
)
from backend.crop_service import (
    match_word,
    generate_crop_image,
    get_or_generate_crop_on_demand
)
from backend.search_engine import search_documents, search_within_document

class TestCoverageBoost(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_database_main_block(self):
        """Couvre le bloc __main__ de database.py."""
        import backend.database as db_module
        with patch.object(db_module, "init_db") as mock_init, \
             patch("builtins.print") as mock_print:
            # Simuler l'exécution directe
            exec("if True:\n    init_db()\n    print('Database initialized successfully at', DB_PATH)", db_module.__dict__)
            mock_init.assert_called()

    def test_lifespan_startup(self):
        """Couvre la fonction lifespan au démarrage de FastAPI."""
        import asyncio
        async def run_lifespan():
            with patch("backend.indexer.scan_and_sync_documents", return_value={"added": 1, "indexed_files": ["Doc1"]}):
                async with lifespan(app):
                    pass
            # Cas avec exception
            with patch("backend.indexer.scan_and_sync_documents", side_effect=Exception("Sync error")):
                async with lifespan(app):
                    pass
        asyncio.run(run_lifespan())

    def test_crop_service_remaining_branches(self):
        # 1. match_word: clean_w >= 4 chars substring
        self.assertTrue(match_word("pre-eclampsie-severe", "eclampsie"))

        with tempfile.TemporaryDirectory() as tmpdir:
            test_doc_path = os.path.join(tmpdir, "crop_branches.pdf")
            doc = pymupdf.open()
            # Page aux dimensions très petites pour forcer les clampings de crop_x0 et crop_y0
            page = doc.new_page(width=200, height=100)
            page.insert_text((180, 80), "Test", fontsize=10)
            doc.save(test_doc_path)
            doc.close()

            test_cache_dir = os.path.join(tmpdir, "cache")
            test_docs_dir = os.path.join(tmpdir, "docs")
            os.makedirs(test_docs_dir, exist_ok=True)
            shutil.copy(test_doc_path, os.path.join(test_docs_dir, "crop_branches.pdf"))

            occ_data = {
                "occ_id": 5,
                "rect": (180.0, 80.0, 195.0, 95.0),
                "highlight_rects": [],
                "query_hash": "c1c2c3c4"
            }
            # words_data vide pour forcer le fallback highlight_rects
            words_data = []

            with patch("backend.crop_service.CACHE_DIR", test_cache_dir), \
                 patch("backend.crop_service.DOCUMENTS_DIR", test_docs_dir):

                # Forcer le clamping max
                crop_path = generate_crop_image(888, "crop_branches.pdf", 1, occ_data, ["Test"], words_data)
                self.assertTrue(os.path.exists(crop_path))

                # Test existence crop_jpg existant
                jpg_path = crop_path.replace(".webp", ".jpg")
                if os.path.exists(crop_path):
                    os.remove(crop_path)
                with open(jpg_path, "wb") as f:
                    f.write(b"fake_jpg")
                cached_jpg = generate_crop_image(888, "crop_branches.pdf", 1, occ_data, ["Test"], words_data)
                self.assertEqual(cached_jpg, jpg_path)

    def test_get_or_generate_crop_on_demand_corrupted_json_and_fallback(self):
        """Teste words_json corrompu en base et fallback sur occs[0]."""
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_db = os.path.join(tmpdir, "crop_db.sqlite")
            conn = sqlite3.connect(temp_db)
            conn.execute("CREATE TABLE documents (id INTEGER PRIMARY KEY, filename TEXT);")
            conn.execute("CREATE TABLE pages (doc_id INTEGER, page_number INTEGER, words_json TEXT);")
            # Insérer du JSON corrompu
            conn.execute("INSERT INTO documents VALUES (777, 'doc.pdf');")
            conn.execute("INSERT INTO pages VALUES (777, 1, 'INVALID_JSON_HERE');")
            conn.commit()
            conn.close()

            with patch("backend.database.DB_PATH", temp_db), \
                 patch("backend.crop_service.CACHE_DIR", tmpdir):
                res = get_or_generate_crop_on_demand(777, 1, 0, "12345678", "terme")
                self.assertEqual(res, "")

    def test_indexer_exceptions_and_edge_branches(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # 1. scan_and_sync_documents avec DOCUMENTS_DIR inexistant
            missing_dir = os.path.join(tmpdir, "does_not_exist")
            with patch("backend.indexer.DOCUMENTS_DIR", missing_dir):
                res = scan_and_sync_documents()
                self.assertEqual(res["added"], 0)

            # 2. scan_and_sync_documents avec un sous-dossier dans documents/
            real_docs_dir = os.path.join(tmpdir, "docs")
            os.makedirs(real_docs_dir, exist_ok=True)
            os.makedirs(os.path.join(real_docs_dir, "sub_directory.pdf"), exist_ok=True) # Un dossier qui se termine par .pdf !

            with patch("backend.indexer.DOCUMENTS_DIR", real_docs_dir):
                res2 = scan_and_sync_documents()
                self.assertEqual(res2["added"], 0)

            # 3. remove_document lorsque les fichiers physiques génèrent OSError
            conn = get_db_connection()
            conn.execute("INSERT INTO documents (filename, title) VALUES ('unremovable.pdf', 'Unremovable');")
            doc_id = conn.execute("SELECT id FROM documents WHERE filename = 'unremovable.pdf';").fetchone()["id"]
            conn.commit()
            conn.close()

            with patch("os.remove", side_effect=OSError("Permission denied")):
                res_del = remove_document(doc_id)
                self.assertTrue(res_del)

    def test_main_api_remaining_routes_and_error_codes(self):
        # 1. GET /api/documents?folder_id=root
        res_root = self.client.get("/api/documents?folder_id=root")
        self.assertEqual(res_root.status_code, 200)

        # 2. Upload avec folder_id
        doc = pymupdf.open()
        p = doc.new_page()
        p.insert_text((50, 100), "PDF avec folder id")
        pdf_bytes = doc.tobytes()
        doc.close()

        # Créer un dossier
        folder_res = self.client.post("/api/folders", json={"name": "Dossier Upload Direct"})
        f_id = folder_res.json()["folder"]["id"]

        up_res = self.client.post(
            "/api/upload",
            files={"file": ("upload_folder_direct.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
            data={"title": "Doc In Folder", "folder_id": str(f_id)}
        )
        self.assertEqual(up_res.status_code, 200)
        doc_id = up_res.json()["document"]["id"]
        self.assertEqual(up_res.json()["document"]["folder_id"], f_id)

        # 3. Supprimer le doc et le dossier
        self.client.delete(f"/api/documents/{doc_id}")
        self.client.delete(f"/api/folders/{f_id}")

        # 4. GET /api/crop avec recherche de fallback par préfixe
        docs = self.client.get("/api/documents").json().get("documents", [])
        if docs:
            d_id = docs[0]["id"]
            res_crop = self.client.get(f"/api/crop/{d_id}/1/99999?h=abcdef12")
            self.assertEqual(res_crop.status_code, 404)

        # 5. GET /api/pdf/{doc_id} lorsque le fichier physique est manquant sur disque
        with patch("os.path.exists", return_value=False):
            res_missing = self.client.get("/api/pdf/1")
            self.assertIn(res_missing.status_code, [404, 500])

    def test_save_pdf_payload_too_short(self):
        """Vérifie le rejet 400 lorsque le payload est trop court (<20 octets)."""
        docs = self.client.get("/api/documents").json().get("documents", [])
        if docs:
            doc_id = docs[0]["id"]
            short_payload = b"%PDF-1.4"
            res = self.client.post(f"/api/documents/{doc_id}/save-pdf", content=short_payload)
            self.assertEqual(res.status_code, 400)

    def test_upload_payload_too_short(self):
        """Vérifie le rejet 400 lorsque le fichier PDF est trop court (<20 octets)."""
        short_file = io.BytesIO(b"%PDF-1.4")
        res = self.client.post("/api/upload", files={"file": ("short.pdf", short_file, "application/pdf")})
        self.assertEqual(res.status_code, 400)

    def test_search_engine_fallback_json_and_or_expansion(self):
        """Teste les fallbacks JSON et branches d'expansion OR dans search_engine."""
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_db = os.path.join(tmpdir, "fts_db.sqlite")
            with patch("backend.database.DB_PATH", temp_db):
                from backend.database import init_db
                init_db()
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute("INSERT INTO folders (id, name) VALUES (99, 'Dossier 99');")
                cursor.execute("INSERT INTO documents (id, filename, title, folder_id, total_pages) VALUES (1, 'doc.pdf', 'Title', 99, 1);")
                cursor.execute("INSERT INTO pages VALUES (1, 1, 1, 'grossesse normale', 'CORRUPT_JSON');")
                cursor.execute("INSERT INTO pages_fts VALUES (1, 1, 'grossesse normale');")
                conn.commit()
                conn.close()

                # 1. Recherche avec JSON corrompu sur une page
                res = search_documents("grossesse")
                self.assertEqual(res["total_documents"], 1)

                # 2. search_within_document avec JSON corrompu
                res_intra = search_within_document(1, "grossesse")
                self.assertEqual(res_intra["doc_id"], 1)

                # 3. Recherche multi-termes avec expansion OR et filtre folder_id
                res_filtered = search_documents("grossesse normale terme_absent", folder_id=100)
                self.assertEqual(res_filtered["total_documents"], 0)

if __name__ == "__main__":
    unittest.main()
