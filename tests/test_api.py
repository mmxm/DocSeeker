import unittest
import io
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

if __name__ == "__main__":
    unittest.main()
