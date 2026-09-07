import unittest
import io
import os
import tempfile
import shutil
import pymupdf
from unittest.mock import patch
from fastapi.testclient import TestClient

from backend.main import app
from backend.database import get_db_connection, init_db

class TestAPIFull(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_health_check_nominal_and_error(self):
        # 1. Nominal
        res = self.client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "ok")

        # 2. Cas d'erreur : base de données inaccessible
        with patch("backend.main.get_db_connection", side_effect=Exception("DB connection error")):
            res_err = self.client.get("/api/health")
            self.assertEqual(res_err.status_code, 503)
            self.assertIn("inaccessible", res_err.json()["detail"].lower())

    def test_folders_api_full_lifecycle(self):
        # 1. Création avec validation d'erreur (nom vide)
        res_bad = self.client.post("/api/folders", json={"name": "   "})
        self.assertEqual(res_bad.status_code, 400)

        # 2. Création valide
        res_create = self.client.post("/api/folders", json={"name": "Dossier API Test", "color": "#ff0000"})
        self.assertEqual(res_create.status_code, 200)
        folder = res_create.json()["folder"]
        folder_id = folder["id"]
        self.assertEqual(folder["name"], "Dossier API Test")
        self.assertEqual(folder["color"], "#ff0000")

        # 3. Création d'un sous-dossier
        res_sub = self.client.post("/api/folders", json={"name": "Sous Dossier API", "parent_id": folder_id})
        self.assertEqual(res_sub.status_code, 200)
        sub_folder_id = res_sub.json()["folder"]["id"]

        # 4. Liste dossiers (tous, root, sous-dossier spécifique)
        res_all = self.client.get("/api/folders")
        self.assertEqual(res_all.status_code, 200)

        res_root = self.client.get("/api/folders?parent_id=root")
        self.assertEqual(res_root.status_code, 200)

        res_filtered = self.client.get(f"/api/folders?parent_id={folder_id}")
        self.assertEqual(res_filtered.status_code, 200)
        sub_ids = [f["id"] for f in res_filtered.json()["folders"]]
        self.assertIn(sub_folder_id, sub_ids)

        # 5. Modification (PATCH)
        res_patch_404 = self.client.patch("/api/folders/999999", json={"name": "Nouveau Nom"})
        self.assertEqual(res_patch_404.status_code, 404)

        res_patch = self.client.patch(f"/api/folders/{folder_id}", json={"name": "Dossier Renomme", "color": "#00ff00"})
        self.assertEqual(res_patch.status_code, 200)

        # 6. Suppression (DELETE)
        res_del_sub = self.client.delete(f"/api/folders/{sub_folder_id}")
        self.assertEqual(res_del_sub.status_code, 200)

        res_del = self.client.delete(f"/api/folders/{folder_id}")
        self.assertEqual(res_del.status_code, 200)

    def test_document_move_and_batch_move_errors(self):
        # 1. Déplacer document inexistant -> 404
        res_move_404 = self.client.patch("/api/documents/999999/move", json={"folder_id": None})
        self.assertEqual(res_move_404.status_code, 404)

        # 2. Récupérer un document existant
        docs_res = self.client.get("/api/documents")
        docs = docs_res.json().get("documents", [])
        if docs:
            doc_id = docs[0]["id"]
            # Déplacer vers dossier inexistant -> 400
            res_bad_folder = self.client.patch(f"/api/documents/{doc_id}/move", json={"folder_id": 888888})
            self.assertEqual(res_bad_folder.status_code, 400)

            # Batch move vers dossier inexistant -> 400
            res_batch_bad = self.client.post("/api/documents/batch-move", json={"doc_ids": [doc_id], "folder_id": 888888})
            self.assertEqual(res_batch_bad.status_code, 400)

            # Batch move liste vide -> 200 avec 0
            res_batch_empty = self.client.post("/api/documents/batch-move", json={"doc_ids": [], "folder_id": None})
            self.assertEqual(res_batch_empty.status_code, 200)
            self.assertEqual(res_batch_empty.json()["moved_count"], 0)

    def test_rename_document_errors(self):
        # Titre vide -> 400
        res_empty = self.client.patch("/api/documents/1", json={"title": "   "})
        self.assertEqual(res_empty.status_code, 400)

        # Doc inexistant -> 404
        res_404 = self.client.patch("/api/documents/999999", json={"title": "Titre Inexistant"})
        self.assertEqual(res_404.status_code, 404)

    def test_annotations_crud_and_pdf_baking(self):
        docs = self.client.get("/api/documents").json().get("documents", [])
        if not docs:
            return
        doc_id = docs[0]["id"]

        # 1. 404 sur doc inexistant
        res_404 = self.client.post("/api/documents/999999/annotations", json={"annotations": []})
        self.assertEqual(res_404.status_code, 404)

        # 2. Sauvegarde avec divers types d'annotations (9=highlight, 3=freetext, 15=ink)
        annots = [
            {"pageIndex": 0, "annotationType": 9, "rect": [10.0, 10.0, 100.0, 30.0], "color": [255, 200, 0]},
            {"pageIndex": 0, "annotationType": 3, "rect": [10.0, 50.0, 200.0, 80.0], "value": "Note clinique", "fontSize": 14},
            {"pageIndex": 0, "annotationType": 15, "paths": [[[10, 10], [20, 20], [30, 10]]]}
        ]
        res_save = self.client.post(f"/api/documents/{doc_id}/annotations", json={"annotations": annots})
        self.assertEqual(res_save.status_code, 200)
        self.assertEqual(res_save.json()["count"], 3)

        # 3. Lecture des annotations
        res_get = self.client.get(f"/api/documents/{doc_id}/annotations")
        self.assertEqual(res_get.status_code, 200)
        self.assertEqual(len(res_get.json()["annotations"]), 3)

        # 4. Lecture annotations sur doc sans annotation
        res_empty = self.client.get("/api/documents/999999/annotations")
        self.assertEqual(res_empty.status_code, 200)
        self.assertEqual(res_empty.json()["annotations"], [])

        # 5. Effacement complet
        res_clear = self.client.post(f"/api/documents/{doc_id}/annotations", json={"annotations": []})
        self.assertEqual(res_clear.status_code, 200)
        self.assertEqual(res_clear.json()["count"], 0)

    def test_save_pdf_document_stream_and_limits(self):
        docs = self.client.get("/api/documents").json().get("documents", [])
        if not docs:
            return
        doc_id = docs[0]["id"]

        # 1. 404 doc inexistant
        res_404 = self.client.post("/api/documents/999999/save-pdf", content=b"%PDF-1.4\n...")
        self.assertEqual(res_404.status_code, 404)

        # 2. Contenu vide ou trop court (< 20 octets)
        res_short = self.client.post(f"/api/documents/{doc_id}/save-pdf", content=b"%PDF-")
        self.assertEqual(res_short.status_code, 400)

        # 3. Contenu non PDF
        res_bad = self.client.post(f"/api/documents/{doc_id}/save-pdf", content=b"INVALID_HEADER_DATA_1234567890")
        self.assertEqual(res_bad.status_code, 400)

    def test_reindex_and_sync_endpoints(self):
        # 1. Reindex doc inexistant -> 404
        res_404 = self.client.post("/api/documents/999999/reindex")
        self.assertEqual(res_404.status_code, 404)

        # 2. Sync
        res_sync = self.client.post("/api/sync")
        self.assertEqual(res_sync.status_code, 200)
        self.assertEqual(res_sync.json()["status"], "success")

    def test_upload_full_flow_and_clean_up(self):
        # Créer un PDF valide
        doc = pymupdf.open()
        p = doc.new_page()
        p.insert_text((50, 100), "PDF de test upload API")
        pdf_bytes = doc.tobytes()
        doc.close()

        # 1. Upload nominal
        res_up = self.client.post(
            "/api/upload",
            files={"file": ("upload_temp_test.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
            data={"title": "PDF Upload Temp"}
        )
        self.assertEqual(res_up.status_code, 200)
        uploaded_doc = res_up.json()["document"]
        doc_id = uploaded_doc["id"]
        self.assertEqual(uploaded_doc["title"], "PDF Upload Temp")

        # 2. Tentative d'upload du même contenu -> 409 Conflict
        res_dup = self.client.post(
            "/api/upload",
            files={"file": ("upload_temp_test_dup.pdf", io.BytesIO(pdf_bytes), "application/pdf")}
        )
        self.assertEqual(res_dup.status_code, 409)
        self.assertEqual(res_dup.json()["error"], "duplicate")

        # 3. Suppression du document de test
        res_del = self.client.delete(f"/api/documents/{doc_id}")
        self.assertEqual(res_del.status_code, 200)

        # 4. Suppression doc inexistant -> 404
        res_del_404 = self.client.delete(f"/api/documents/{doc_id}")
        self.assertEqual(res_del_404.status_code, 404)

    def test_pdf_streaming_and_range_headers(self):
        docs = self.client.get("/api/documents").json().get("documents", [])
        if not docs:
            return
        doc_id = docs[0]["id"]

        # 1. Doc inexistant -> 404
        res_404 = self.client.get("/api/pdf/999999")
        self.assertEqual(res_404.status_code, 404)

        # 2. Stream complet sans Range (200 OK avec headers Accept-Ranges)
        res_full = self.client.get(f"/api/pdf/{doc_id}")
        self.assertEqual(res_full.status_code, 200)
        self.assertEqual(res_full.headers.get("Accept-Ranges"), "bytes")
        self.assertIn("ETag", res_full.headers)

        # 3. Range partiel bytes=0-200 (206 Partial Content)
        res_206 = self.client.get(f"/api/pdf/{doc_id}", headers={"Range": "bytes=0-200"})
        self.assertEqual(res_206.status_code, 206)
        self.assertEqual(len(res_206.content), 201)
        self.assertIn("bytes 0-200/", res_206.headers.get("Content-Range", ""))

        # 4. Range avec fin ouverte bytes=100-
        res_open = self.client.get(f"/api/pdf/{doc_id}", headers={"Range": "bytes=100-"})
        self.assertEqual(res_open.status_code, 206)

        # 5. Range hors limites bytes=99999999- (416 Range Not Satisfiable)
        res_416 = self.client.get(f"/api/pdf/{doc_id}", headers={"Range": "bytes=99999999-"})
        self.assertEqual(res_416.status_code, 416)

        # 6. Range avec format invalide -> rejet Starlette 400 Bad Request ou fallback 200 OK
        res_fallback = self.client.get(f"/api/pdf/{doc_id}", headers={"Range": "invalid_range_format"})
        self.assertIn(res_fallback.status_code, [200, 400])

    def test_cover_and_crop_endpoints(self):
        # 1. Couverture inexistante -> 404
        res_cover_404 = self.client.get("/api/cover/999999")
        self.assertEqual(res_cover_404.status_code, 404)

        # 2. Couverture existante (si doc présent)
        docs = self.client.get("/api/documents").json().get("documents", [])
        if docs:
            doc_id = docs[0]["id"]
            res_cover = self.client.get(f"/api/cover/{doc_id}")
            if res_cover.status_code == 200:
                self.assertIn("public, max-age=31536000, immutable", res_cover.headers.get("Cache-Control", ""))

            # 3. Crop avec hash invalide -> 400
            res_bad_hash = self.client.get(f"/api/crop/{doc_id}/1/0?h=invalid;hash!")
            self.assertEqual(res_bad_hash.status_code, 400)

            # 4. Crop inexistant -> 404
            res_crop_404 = self.client.get("/api/crop/999999/1/99?h=abcd1234")
            self.assertEqual(res_crop_404.status_code, 404)

    def test_static_files_no_cache_headers(self):
        res = self.client.get("/")
        self.assertEqual(res.status_code, 200)
        self.assertIn("no-cache", res.headers.get("Cache-Control", "").lower())

if __name__ == "__main__":
    unittest.main()
