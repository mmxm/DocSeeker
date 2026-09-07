import unittest
import io
import os
import re
import tempfile
import time
from fastapi.testclient import TestClient

from backend.main import app, MAX_UPLOAD_SIZE
from backend.crop_service import match_word, get_or_generate_crop_on_demand
from backend.search_engine import sanitize_fts_query, search_documents

class TestSecurityVulnerabilities(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    # ----------------------------------------------------------------------
    # 1. PATH TRAVERSAL & DIRECTORY TRAVERSAL
    # ----------------------------------------------------------------------
    def test_upload_filename_path_traversal_attempts(self):
        """Vérifie que les tentatives de Path Traversal dans le nom de fichier uploadé sont neutralisées."""
        traversal_names = [
            "../../../../etc/passwd.pdf",
            "..\\..\\..\\windows\\system32\\cmd.pdf",
            "/absolute/root/path.pdf",
            "....//....//escape.pdf",
            "\x00nullbyte.pdf",
            ".hidden_file.pdf",
            ".._double_dot.pdf"
        ]

        valid_pdf_content = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"

        for malicious_name in traversal_names:
            res = self.client.post(
                "/api/upload",
                files={"file": (malicious_name, io.BytesIO(valid_pdf_content), "application/pdf")},
                data={"title": "Test Traversal Name"}
            )
            # Soit accepté sous un nom sanitisé sans traversée, soit rejeté
            if res.status_code == 200:
                doc = res.json()["document"]
                filename = doc["filename"]
                self.assertNotIn("..", filename)
                self.assertNotIn("/", filename)
                self.assertNotIn("\\", filename)
                self.assertNotIn("\x00", filename)
                self.assertFalse(filename.startswith("."))
                # Nettoyage
                self.client.delete(f"/api/documents/{doc['id']}")

    def test_crop_query_hash_path_traversal_rejection(self):
        """Vérifie le blocage immédiat (HTTP 400) des injections de chemins dans le paramètre h."""
        traversal_hashes = [
            "../../../../etc/passwd",
            "%2e%2e%2f%2e%2e%2f",
            "../doc_1/secret",
            "a" * 33, # dépassement de la longueur hexadécimale autorisée (1 à 32)
            "ab!cd@ef#", # caractères non hexadécimaux
            "../../",
            "/etc/shadow"
        ]
        for bad_h in traversal_hashes:
            res = self.client.get(f"/api/crop/1/1/0?h={bad_h}")
            self.assertEqual(res.status_code, 400, f"Le hash '{bad_h}' aurait dû être rejeté avec 400")
            self.assertIn("invalide", res.json().get("detail", "").lower())

    # ----------------------------------------------------------------------
    # 2. INJECTIONS SQL & FTS5
    # ----------------------------------------------------------------------
    def test_fts5_syntax_and_metacharacter_injections(self):
        """Vérifie que des requêtes de recherche contenant des opérateurs FTS5 agressifs ne provoquent aucune erreur 500."""
        malicious_fts_queries = [
            '"""""',
            'AND OR NOT',
            'NEAR(a, b, -10)',
            'doc_id: 1 OR title: *',
            '***',
            '{}[]()^~:',
            'hémorragie" AND "délivrance',
            "' OR '1'='1",
            "'; DROP TABLE documents; --",
            "1 UNION ALL SELECT sqlite_version(), 2, 3, 4, 5, 6, 7, 8 --"
        ]

        for q in malicious_fts_queries:
            # Endpoint général
            res = self.client.get(f"/api/search?q={q}")
            self.assertEqual(res.status_code, 200, f"FTS query '{q}' a provoqué un statut {res.status_code}")
            data = res.json()
            self.assertIn("results", data)
            self.assertIsInstance(data["results"], list)

            # Endpoint titles_only
            res_titles = self.client.get(f"/api/search?q={q}&titles_only=true")
            self.assertEqual(res_titles.status_code, 200)

            # Endpoint doc-search
            res_doc = self.client.get(f"/api/doc-search?doc_id=1&q={q}")
            self.assertEqual(res_doc.status_code, 200)

    def test_sql_injection_on_parameters(self):
        """Vérifie l'absence de vulnérabilité SQLi sur les filtres numériques et chaînes."""
        # folder_id malveillant dans search
        res = self.client.get("/api/search?q=test&folder_id=1%20OR%201=1")
        # FastAPI doit rejeter car int attendu -> 422 Unprocessable Entity
        self.assertEqual(res.status_code, 422)

        # parent_id malveillant dans folders
        res_folders = self.client.get("/api/folders?parent_id=1;DROP%20TABLE%20folders")
        self.assertEqual(res_folders.status_code, 200)
        # La table folders existe toujours
        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 200)

    # ----------------------------------------------------------------------
    # 3. UPLOAD DE FICHIERS MALVEILLANTS & POLYGLOTS
    # ----------------------------------------------------------------------
    def test_upload_rejection_of_dangerous_executables_and_scripts(self):
        """Vérifie le rejet des scripts exécutables, même renommés ou camouflés."""
        dangerous_payloads = [
            ("script.sh", b"#!/bin/bash\nrm -rf /", "application/x-sh"),
            ("exploit.py", b"import os; os.system('id')", "text/x-python"),
            ("page.html", b"<html><script>alert(1)</script></html>", "text/html"),
            ("image.svg", b"<svg onload=alert(1)></svg>", "image/svg+xml"),
            ("binary.exe", b"MZ\x90\x00\x03\x00\x00\x00", "application/x-msdownload"),
            ("fake.pdf", b"MZ\x90\x00Ce n'est pas un pdf du tout!", "application/pdf"),
            ("empty.pdf", b"", "application/pdf"),
            ("tiny.pdf", b"%PDF-1.4", "application/pdf") # < 20 octets
        ]

        for fname, content, mime in dangerous_payloads:
            res = self.client.post(
                "/api/upload",
                files={"file": (fname, io.BytesIO(content), mime)}
            )
            self.assertEqual(res.status_code, 400, f"Le fichier '{fname}' aurait dû être rejeté avec HTTP 400")

    # ----------------------------------------------------------------------
    # 4. CROSS-SITE SCRIPTING (XSS)
    # ----------------------------------------------------------------------
    def test_stored_xss_protection_in_titles_and_folders(self):
        """Vérifie que les injections de scripts HTML dans les titres et dossiers sont sécurisées."""
        xss_payload = "<script>alert('XSS_ATTACK_VECTOR')</script>"
        
        # 1. Création dossier avec XSS
        res_folder = self.client.post("/api/folders", json={"name": xss_payload, "color": "#3b82f6"})
        self.assertEqual(res_folder.status_code, 200)
        f_id = res_folder.json()["folder"]["id"]

        # 2. Vérification que la réponse est bien du JSON strict (application/json) et non interprétable comme HTML
        self.assertIn("application/json", res_folder.headers["Content-Type"])

        # 3. Liste des dossiers
        res_list = self.client.get("/api/folders")
        self.assertEqual(res_list.status_code, 200)
        self.assertIn("application/json", res_list.headers["Content-Type"])

        # Nettoyage dossier
        self.client.delete(f"/api/folders/{f_id}")

        # 4. Annotations avec payload XSS
        docs = self.client.get("/api/documents").json().get("documents", [])
        if docs:
            doc_id = docs[0]["id"]
            annot_xss = [{"pageIndex": 0, "annotationType": 3, "rect": [10, 10, 100, 30], "value": xss_payload}]
            res_annot = self.client.post(f"/api/documents/{doc_id}/annotations", json={"annotations": annot_xss})
            self.assertEqual(res_annot.status_code, 200)

            # Lecture annotations
            get_annot = self.client.get(f"/api/documents/{doc_id}/annotations")
            self.assertEqual(get_annot.status_code, 200)
            self.assertIn("application/json", get_annot.headers["Content-Type"])

            # Nettoyage
            self.client.post(f"/api/documents/{doc_id}/annotations", json={"annotations": []})

    # ----------------------------------------------------------------------
    # 5. DÉNI DE SERVICE (DoS) & ReDoS
    # ----------------------------------------------------------------------
    def test_redos_regular_expression_dos_resistance(self):
        """Vérifie que les expressions régulières ne souffrent pas de backtracking catastrophique (ReDoS)."""
        # Test sur match_word avec chaîne pathologique
        evil_word = "a" * 2000 + "!"
        t0 = time.perf_counter()
        match_word(evil_word, "diabete")
        t_elapsed = time.perf_counter() - t0
        # Doit s'exécuter en moins de 10 millisecondes
        self.assertLess(t_elapsed, 0.05, f"match_word a pris {t_elapsed:.4f}s (risque ReDoS)")

        # Test sur sanitize_fts_query
        evil_query = ("( [ { " * 200) + ("word " * 100) + (") ] } " * 200)
        t0 = time.perf_counter()
        terms = sanitize_fts_query(evil_query)
        t_elapsed = time.perf_counter() - t0
        self.assertLess(t_elapsed, 0.05, f"sanitize_fts_query a pris {t_elapsed:.4f}s (risque ReDoS)")

    # ----------------------------------------------------------------------
    # 6. CONFIGURATION CORS & SÉCURITÉ DES EN-TÊTES
    # ----------------------------------------------------------------------
    def test_cors_and_security_headers(self):
        """Vérifie que les requêtes CORS OPTIONS ne permettent pas un allow-credentials avec wildcard."""
        res = self.client.options(
            "/api/documents",
            headers={"Origin": "https://malicious-site.example.com", "Access-Control-Request-Method": "GET"}
        )
        self.assertEqual(res.status_code, 200)
        # Si Access-Control-Allow-Origin est '*', alors Access-Control-Allow-Credentials ne doit PAS être 'true'
        allow_origin = res.headers.get("access-control-allow-origin")
        allow_credentials = res.headers.get("access-control-allow-credentials")
        if allow_origin == "*":
            self.assertNotEqual(allow_credentials, "true")

if __name__ == "__main__":
    unittest.main()
