import unittest
import io
from fastapi.testclient import TestClient
from backend.main import app

class TestSecurity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_health_check_endpoint(self):
        """Vérifie que le endpoint de santé fonctionne pour Docker et le reverse proxy."""
        response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data.get("status"), "ok")
        self.assertEqual(data.get("service"), "DocSeeker")

    def test_path_traversal_on_crop_endpoint(self):
        """Vérifie que les tentatives de Path Traversal sur le paramètre hash sont bloquées avec HTTP 400."""
        # Tentative avec séquence ../..
        response = self.client.get("/api/crop/1/1/0?h=../../../../etc/passwd")
        self.assertEqual(response.status_code, 400)
        self.assertIn("invalide", response.json().get("detail", "").lower())

        # Tentative avec injection de caractères de contrôle ou slashs
        response = self.client.get("/api/crop/1/1/0?h=%2e%2e%2f%2e%2e%2f")
        self.assertEqual(response.status_code, 400)

    def test_upload_non_pdf_file_rejected(self):
        """Vérifie que les faux fichiers PDF (scripts, exécutables) sont rejetés avec HTTP 400."""
        fake_pdf_content = b"#!/bin/bash\necho 'Malicious script'\n"
        response = self.client.post(
            "/api/upload",
            files={"file": ("malicious.pdf", io.BytesIO(fake_pdf_content), "application/pdf")}
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("signature manquante", response.json().get("detail", ""))

    def test_upload_invalid_extension_rejected(self):
        """Vérifie qu'un fichier n'ayant pas l'extension .pdf est immédiatement rejeté."""
        response = self.client.post(
            "/api/upload",
            files={"file": ("script.sh", io.BytesIO(b"echo 1"), "text/x-shellscript")}
        )
        self.assertEqual(response.status_code, 400)

    def test_save_pdf_invalid_signature_rejected(self):
        """Vérifie que l'endpoint save-pdf rejette les contenus qui ne sont pas des PDF."""
        # Trouver un document existant
        docs_res = self.client.get("/api/documents")
        docs = docs_res.json().get("documents", [])
        if docs:
            doc_id = docs[0]["id"]
            response = self.client.post(
                f"/api/documents/{doc_id}/save-pdf",
                content=b"NOT_A_PDF_CONTENT_AT_ALL_1234567890",
                headers={"Content-Type": "application/pdf"}
            )
            self.assertEqual(response.status_code, 400)
            self.assertIn("signature", response.json().get("detail", ""))

if __name__ == "__main__":
    unittest.main()
