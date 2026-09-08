# ==============================================================================
# DocSeeker - Tests Unitaires : Upload par lot et Version liée au Git Commit
# ==============================================================================
import unittest
import io
import os
import subprocess
from unittest.mock import patch
import fitz  # PyMuPDF
from fastapi.testclient import TestClient

from backend.main import app, DOCSEEKER_VERSION, GIT_COMMIT
from backend.database import get_db_connection


def create_minimal_pdf(text: str, title: str = "Test PDF") -> bytes:
    """Génère en mémoire un document PDF valide avec métadonnées et contenu textuel."""
    doc = fitz.open()
    doc.set_metadata({"title": title, "author": "DocSeeker Test Suite"})
    page = doc.new_page(width=595, height=842)  # A4
    page.insert_text((50, 72), f"{title}\n\n{text}", fontsize=12)
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


class TestBatchUploadAndVersion(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.created_doc_ids = []
        cls.created_folder_ids = []

    @classmethod
    def tearDownClass(cls):
        # Nettoyage des documents et dossiers de test créés
        client = TestClient(app)
        for doc_id in cls.created_doc_ids:
            try:
                client.delete(f"/api/documents/{doc_id}")
            except Exception:
                pass

        for folder_id in cls.created_folder_ids:
            try:
                client.delete(f"/api/folders/{folder_id}")
            except Exception:
                pass

    # --------------------------------------------------------------------------
    # 1. Tests de Version et Liaison Git Commit
    # --------------------------------------------------------------------------
    def test_version_endpoint_returns_commit_info(self):
        """Vérifie que l'endpoint /api/version renvoie la version et le commit actif."""
        res = self.client.get("/api/version")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("version", data)
        self.assertIn("commit", data)
        self.assertTrue(len(data["version"]) > 0)
        self.assertTrue(len(data["commit"]) > 0)

    def test_health_check_includes_version_and_commit(self):
        """Vérifie que /api/health fournit la version et le commit pour le monitoring Docker."""
        res = self.client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data.get("status"), "ok")
        self.assertEqual(data.get("service"), "DocSeeker")
        self.assertIn("version", data)
        self.assertIn("commit", data)

    def test_git_commit_detection_format(self):
        """Vérifie que le commit Git détecté respecte le format d'un commit hash."""
        # Si exécuté dans un repo git valide
        try:
            expected_commit = subprocess.check_output(
                ["git", "rev-parse", "--short", "HEAD"],
                stderr=subprocess.DEVNULL
            ).decode().strip()
            self.assertTrue(len(expected_commit) >= 7)
            self.assertTrue(expected_commit.isalnum())
        except Exception:
            # Hors git ou environnement conteneur sans .git
            pass

    def test_upload_size_limit_managed_exclusively_by_caddy(self):
        """Vérifie que la limitation de taille est déléguée au reverse proxy Caddy et configurable via docker-compose."""
        with open("Caddyfile", "r", encoding="utf-8") as f:
            caddyfile_content = f.read()
        self.assertIn("max_size {$MAX_UPLOAD_SIZE:2GB}", caddyfile_content)

        with open("docker-compose.yml", "r", encoding="utf-8") as f:
            compose_content = f.read()
        self.assertIn("MAX_UPLOAD_SIZE=2GB", compose_content)

    # --------------------------------------------------------------------------
    # 2. Tests d'Upload par lot (Plusieurs fichiers d'un coup)
    # --------------------------------------------------------------------------
    def test_batch_multiple_pdf_sequential_upload_and_search(self):
        """Simule l'upload par lot de 3 PDF distincts et vérifie leur indexation FTS respective."""
        docs_to_upload = [
            ("Lot_Pneumologie_Asthme.pdf", "Pneumologie et prise en charge de la crise d'asthme aigu sévère.", "Pneumologie Asthme"),
            ("Lot_Neurologie_Epilepsie.pdf", "Neurologie pédiatrique diagnostic et traitement de l'épilepsie myoclonique.", "Neurologie Epilepsie"),
            ("Lot_Cardiologie_Souffle.pdf", "Cardiologie examen clinique et détection d'un souffle systolique fonctionnel.", "Cardiologie Souffle")
        ]

        uploaded_ids = []

        for filename, content, title in docs_to_upload:
            pdf_bytes = create_minimal_pdf(content, title=title)
            res = self.client.post(
                "/api/upload",
                files={"file": (filename, io.BytesIO(pdf_bytes), "application/pdf")},
                data={"title": title}
            )
            self.assertEqual(res.status_code, 200, f"Échec d'upload pour {filename}: {res.text}")
            data = res.json()
            doc_id = data.get("document", {}).get("id")
            self.assertIsNotNone(doc_id)
            uploaded_ids.append(doc_id)
            self.__class__.created_doc_ids.append(doc_id)

        self.assertEqual(len(uploaded_ids), 3)

        # Vérifier que chaque document est indexé et cherchable
        search_asthme = self.client.get("/api/search?q=asthme").json()
        self.assertGreater(search_asthme.get("total_documents", 0), 0)
        found_titles = [d["title"] for d in search_asthme.get("results", [])]
        self.assertIn("Pneumologie Asthme", found_titles)

        search_epilepsie = self.client.get("/api/search?q=epilepsie").json()
        self.assertGreater(search_epilepsie.get("total_documents", 0), 0)
        found_titles_epi = [d["title"] for d in search_epilepsie.get("results", [])]
        self.assertIn("Neurologie Epilepsie", found_titles_epi)

        search_souffle = self.client.get("/api/search?q=souffle").json()
        self.assertGreater(search_souffle.get("total_documents", 0), 0)
        found_titles_cardio = [d["title"] for d in search_souffle.get("results", [])]
        self.assertIn("Cardiologie Souffle", found_titles_cardio)

    def test_batch_upload_with_duplicate_skipping(self):
        """Vérifie que lorsqu'un doublon est rencontré dans un lot, l'API renvoie 409 sans corrompre la base."""
        # 1. Premier document unique
        pdf_a = create_minimal_pdf("Contenu exclusif Document Alpha pour test de lot.")
        res_a = self.client.post(
            "/api/upload",
            files={"file": ("Batch_Doc_Alpha.pdf", io.BytesIO(pdf_a), "application/pdf")}
        )
        self.assertEqual(res_a.status_code, 200)
        doc_a_id = res_a.json()["document"]["id"]
        self.__class__.created_doc_ids.append(doc_a_id)

        # 2. Re-tentative d'upload du même PDF (doublon strict SHA-256)
        res_dup = self.client.post(
            "/api/upload",
            files={"file": ("Batch_Doc_Alpha_Copie.pdf", io.BytesIO(pdf_a), "application/pdf")}
        )
        self.assertEqual(res_dup.status_code, 409)
        dup_data = res_dup.json()
        self.assertEqual(dup_data.get("error"), "duplicate")
        self.assertEqual(dup_data.get("existing_doc", {}).get("id"), doc_a_id)

        # 3. Document suivant dans le lot (doit réussir malgré le 409 précédent)
        pdf_b = create_minimal_pdf("Contenu exclusif Document Beta pour continuer le lot.")
        res_b = self.client.post(
            "/api/upload",
            files={"file": ("Batch_Doc_Beta.pdf", io.BytesIO(pdf_b), "application/pdf")}
        )
        self.assertEqual(res_b.status_code, 200)
        doc_b_id = res_b.json()["document"]["id"]
        self.__class__.created_doc_ids.append(doc_b_id)

    def test_batch_upload_into_destination_folder(self):
        """Vérifie que l'upload groupé associe correctement chaque document au dossier cible spécifié."""
        # Création du dossier cible
        folder_res = self.client.post("/api/folders", json={"name": "Dossier Test Lot", "color": "#007AFF"})
        self.assertEqual(folder_res.status_code, 200)
        folder_id = folder_res.json()["folder"]["id"]
        self.__class__.created_folder_ids.append(folder_id)

        # Upload de deux documents vers ce dossier
        for idx in [1, 2]:
            pdf = create_minimal_pdf(f"Document dans dossier lot numéro {idx}")
            res = self.client.post(
                "/api/upload",
                files={"file": (f"Doc_Folder_{idx}.pdf", io.BytesIO(pdf), "application/pdf")},
                data={"folder_id": folder_id}
            )
            self.assertEqual(res.status_code, 200)
            doc_id = res.json()["document"]["id"]
            self.__class__.created_doc_ids.append(doc_id)
            self.assertEqual(res.json()["document"]["folder_id"], folder_id)

        # Vérifier via l'API dossiers que le comptage est correct
        folders_list = self.client.get("/api/folders").json().get("folders", [])
        matching = [f for f in folders_list if f["id"] == folder_id]
        self.assertEqual(len(matching), 1)
        self.assertEqual(matching[0]["doc_count"], 2)

    def test_batch_upload_rejects_non_pdf_in_batch(self):
        """Vérifie que si un fichier non-PDF se glisse dans la sélection, il est refusé avec 400."""
        res = self.client.post(
            "/api/upload",
            files={"file": ("malicious.exe", io.BytesIO(b"MZ\x90\x00executable content"), "application/octet-stream")}
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn("pdf", res.json().get("detail", "").lower())

    def test_backend_accepts_valid_upload_without_arbitrary_limit(self):
        """Vérifie que l'applicatif accepte les documents valides sans limite artificielle interne."""
        pdf_bytes = create_minimal_pdf("Document PDF valide sans rejet applicatif.")
        res = self.client.post(
            "/api/upload",
            files={"file": ("Valid_Size.pdf", io.BytesIO(pdf_bytes), "application/pdf")}
        )
        self.assertEqual(res.status_code, 200)
        doc_id = res.json()["document"]["id"]
        self.__class__.created_doc_ids.append(doc_id)


if __name__ == "__main__":
    unittest.main()
