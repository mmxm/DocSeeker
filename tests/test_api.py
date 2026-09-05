import unittest
import io
import os
from fastapi.testclient import TestClient
from backend.main import app

class TestAPI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_get_documents(self):
        response = self.client.get("/api/documents")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("documents", data)
        self.assertIn("total", data)
        self.assertGreater(data["total"], 0)

    def test_search_endpoint(self):
        response = self.client.get("/api/search?q=grossesse")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("results", data)
        self.assertGreater(data["total_documents"], 0)

    def test_doc_search_endpoint(self):
        response = self.client.get("/api/doc-search?doc_id=2&q=grossesse")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("occurrences", data)

    def test_pdf_range_streaming(self):
        # Test HTTP 206 Range request pour PDF.js
        headers = {"Range": "bytes=0-100"}
        response = self.client.get("/api/pdf/2", headers=headers)
        self.assertEqual(response.status_code, 206)
        self.assertIn("bytes 0-100/", response.headers.get("content-range", ""))
        self.assertEqual(len(response.content), 101)

    def test_duplicate_upload_conflict(self):
        # Téléverser un fichier déjà existant (même contenu)
        with open("data/documents/023 - Grossesse normale.pdf", "rb") as f:
            pdf_bytes = f.read()

        response = self.client.post(
            "/api/upload",
            files={"file": ("023 - Grossesse normale.pdf", io.BytesIO(pdf_bytes), "application/pdf")}
        )
        # Doit renvoyer HTTP 409 Conflict
        self.assertEqual(response.status_code, 409)
        data = response.json()
        self.assertEqual(data.get("error"), "duplicate")
        self.assertIn("existing_doc", data)

    def test_rename_document(self):
        # Récupérer un document
        res = self.client.get("/api/documents")
        docs = res.json().get("documents", [])
        self.assertGreater(len(docs), 0)
        doc_id = docs[0]["id"]
        original_title = docs[0]["title"]

        # Renommer
        new_title = "Nouveau Titre Test"
        patch_res = self.client.patch(f"/api/documents/{doc_id}", json={"title": new_title})
        self.assertEqual(patch_res.status_code, 200)
        self.assertEqual(patch_res.json()["title"], new_title)

        # Vérifier que le titre a bien persisté
        get_res = self.client.get("/api/documents")
        updated_doc = next(d for d in get_res.json()["documents"] if d["id"] == doc_id)
        self.assertEqual(updated_doc["title"], new_title)

        # Restaurer l'original
        self.client.patch(f"/api/documents/{doc_id}", json={"title": original_title})

    def test_annotations_endpoints(self):
        res = self.client.get("/api/documents")
        docs = res.json().get("documents", [])
        self.assertGreater(len(docs), 0)
        doc_id = docs[0]["id"]

        # Sauvegarder des annotations légères
        sample_annots = [
            {
                "pageIndex": 0,
                "annotationType": 9,
                "rect": [100.0, 200.0, 300.0, 220.0],
                "color": [255, 235, 59]
            },
            {
                "pageIndex": 0,
                "annotationType": 3,
                "rect": [50.0, 50.0, 150.0, 80.0],
                "value": "Note importante"
            }
        ]
        post_res = self.client.post(f"/api/documents/{doc_id}/annotations", json={"annotations": sample_annots})
        self.assertEqual(post_res.status_code, 200)
        self.assertEqual(post_res.json().get("count"), 2)

        # Récupérer les annotations
        get_res = self.client.get(f"/api/documents/{doc_id}/annotations")
        self.assertEqual(get_res.status_code, 200)
        annots_data = get_res.json()
        self.assertIn("annotations", annots_data)
        self.assertEqual(len(annots_data["annotations"]), 2)
        self.assertEqual(annots_data["annotations"][0]["annotationType"], 9)

        # Backup document original bytes
        doc_filename = docs[0]["filename"]
        pdf_path = os.path.join("data/documents", doc_filename)
        orig_bytes = None
        if os.path.exists(pdf_path):
            with open(pdf_path, "rb") as f:
                orig_bytes = f.read()

        try:
            # Tester l'endpoint /api/documents/{doc_id}/save-pdf
            pdf_content = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"
            save_pdf_res = self.client.post(
                f"/api/documents/{doc_id}/save-pdf",
                content=pdf_content,
                headers={"Content-Type": "application/pdf"}
            )
            self.assertEqual(save_pdf_res.status_code, 200)
            self.assertEqual(save_pdf_res.json()["status"], "success")
            self.assertEqual(save_pdf_res.json()["size"], len(pdf_content))
        finally:
            if orig_bytes is not None and os.path.exists(pdf_path):
                with open(pdf_path, "wb") as f:
                    f.write(orig_bytes)
            # Nettoyer les annotations de test
            self.client.post(f"/api/documents/{doc_id}/annotations", json={"annotations": []})

    def test_documents_and_search_sorting_fields(self):
        # Vérifier que GET /api/documents renvoie bien created_at et updated_at
        res = self.client.get("/api/documents")
        self.assertEqual(res.status_code, 200)
        docs = res.json().get("documents", [])
        self.assertGreater(len(docs), 0)
        for d in docs:
            self.assertIn("created_at", d)
            self.assertIn("updated_at", d)

        # Vérifier que GET /api/search renvoie bien created_at et updated_at
        search_res = self.client.get("/api/search?q=grossesse")
        self.assertEqual(search_res.status_code, 200)
        results = search_res.json().get("results", [])
        self.assertGreater(len(results), 0)
        for r in results:
            self.assertIn("created_at", r)
            self.assertIn("updated_at", r)

if __name__ == "__main__":
    unittest.main()
