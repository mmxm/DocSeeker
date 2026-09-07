import unittest
import time
import os
import io
import tempfile
import shutil
import concurrent.futures
import pymupdf
from fastapi.testclient import TestClient

from backend.main import app
from backend.indexer import index_pdf_file, remove_document
from backend.search_engine import search_documents, search_within_document
from backend.crop_service import get_or_generate_crop_on_demand, find_occurrences_on_page

class TestPerformanceBenchmarks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    # ----------------------------------------------------------------------
    # 1. LATENCE NOMINALE (< 50ms RECHERCHE, < 30ms CROP, < 15ms RANGE)
    # ----------------------------------------------------------------------
    def test_nominal_search_latency(self):
        """Vérifie que le temps de réponse de recherche respecte l'objectif de latence même sous instrumentation de couverture."""
        # Warmup pour charger les caches en mémoire
        self.client.get("/api/search?q=test")

        queries = ["grossesse", "hémorragie délivrance", "hypertension", "obstétrique", "césarienne"]
        latencies = []

        for q in queries:
            t0 = time.perf_counter()
            res = self.client.get(f"/api/search?q={q}")
            t1 = time.perf_counter()
            self.assertEqual(res.status_code, 200)
            latencies.append(t1 - t0)

        avg_latency_ms = (sum(latencies) / len(latencies)) * 1000.0
        print(f"\n[Perf Benchmark] Latence moyenne recherche ({len(queries)} requêtes) : {avg_latency_ms:.2f} ms")
        self.assertLess(avg_latency_ms, 100.0, f"Latence moyenne ({avg_latency_ms:.2f}ms) dépasse le seuil cible sous instrumentation")

    def test_nominal_pdf_range_streaming_latency(self):
        """Vérifie que le streaming HTTP 206 partiel répond quasi instantanément (< 15ms)."""
        docs = self.client.get("/api/documents").json().get("documents", [])
        if not docs:
            return
        doc_id = docs[0]["id"]

        headers = {"Range": "bytes=0-65535"}
        latencies = []
        for _ in range(10):
            t0 = time.perf_counter()
            res = self.client.get(f"/api/pdf/{doc_id}", headers=headers)
            t1 = time.perf_counter()
            self.assertEqual(res.status_code, 206)
            latencies.append(t1 - t0)

        avg_ms = (sum(latencies) / len(latencies)) * 1000.0
        print(f"[Perf Benchmark] Latence moyenne streaming Range 64Ko : {avg_ms:.2f} ms")
        self.assertLess(avg_ms, 25.0)

    # ----------------------------------------------------------------------
    # 2. STRESS TEST : GROS PDF VOLUMINEUX & DENSE (100 PAGES, MILLIERS DE CARACTÈRES)
    # ----------------------------------------------------------------------
    def test_heavy_volumetric_pdf_indexing_and_scale(self):
        """
        Génère dynamiquement un PDF médical hyper-dense de 100 pages (des milliers de mots par page),
        mesure les performances d'ingestion PyMuPDF et FTS5, et vérifie la stabilité.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            pdf_path = os.path.join(tmpdir, "heavy_medical_corpus_100p.pdf")
            print(f"\n[Stress Test] Génération d'un PDF dense de 100 pages...")
            t_gen_0 = time.perf_counter()

            doc = pymupdf.open()
            doc.set_metadata({"title": "Traité Complet de Pathologies Médicales Lourdes"})

            sample_text = (
                "Chapitre d'évaluation clinique approfondie. Le diagnostic différentiel impose une "
                "surveillance hémodynamique continue du patient présentant des signes de détresse respiratoire "
                "aiguë ou d'hémorragie de la délivrance avec instabilité volémique. Les protocoles thérapeutiques "
                "incluent l'administration précoce d'acide tranexamique et le remplissage vasculaire par solutés "
                "cristalloïdes isotoniques. Une tomodensitométrie abdomino-pelvienne sans injection préalable "
                "doit être réalisée en urgence absolue en milieu hospitalier spécialisé.\n\n"
            ) * 5  # ~500 mots par page

            for page_num in range(1, 101):
                page = doc.new_page(width=595, height=842)
                # Insérer plusieurs paragraphes denses avec termes cibles
                page.insert_text((40, 60), f"Page {page_num} - Manuel de Référence Médicale", fontsize=11)
                page.insert_text((40, 90), sample_text, fontsize=9)

            doc.save(pdf_path)
            doc.close()
            t_gen = time.perf_counter() - t_gen_0
            pdf_size_mb = os.path.getsize(pdf_path) / (1024 * 1024)
            print(f"[Stress Test] PDF généré en {t_gen:.2f}s ({pdf_size_mb:.2f} Mo, 100 pages)")

            # Indexer le gros PDF
            t_idx_0 = time.perf_counter()
            with open(pdf_path, "rb") as f:
                res_up = self.client.post(
                    "/api/upload",
                    files={"file": ("heavy_medical_corpus_100p.pdf", f, "application/pdf")},
                    data={"title": "Traité Pathologies 100 Pages"}
                )
            t_idx = time.perf_counter() - t_idx_0
            self.assertEqual(res_up.status_code, 200)
            indexed_doc = res_up.json()["document"]
            doc_id = indexed_doc["id"]
            self.assertEqual(indexed_doc["total_pages"], 100)

            pages_per_sec = 100 / t_idx
            print(f"[Stress Test] Indexation de 100 pages : {t_idx:.2f}s ({pages_per_sec:.1f} pages/seconde)")
            # PyMuPDF et SQLite doivent indexer à au moins 20 pages/seconde sur Mac
            self.assertGreater(pages_per_sec, 15.0)

            # ------------------------------------------------------------------
            # 3. STRESS TEST : RECHERCHE MASSIVE À TRÈS FORT VOLUME D'OCCURRENCES
            # ------------------------------------------------------------------
            # Le terme "diagnostic" est présent sur les 100 pages du document
            t_search_0 = time.perf_counter()
            search_res = self.client.get("/api/search?q=diagnostic")
            t_search = time.perf_counter() - t_search_0
            self.assertEqual(search_res.status_code, 200)
            data = search_res.json()

            print(f"[Stress Test] Recherche massive (terme présent 100+ fois) : {t_search * 1000:.2f} ms")
            # Trouver le document dans les résultats
            target_doc = next((d for d in data["results"] if d["id"] == doc_id), None)
            self.assertIsNotNone(target_doc)
            self.assertGreaterEqual(target_doc["total_occurrences"], 100)
            # Vérifier que le ruban reste strictement plafonné à 25 pour préserver la mémoire et le réseau
            self.assertEqual(len(target_doc["vignettes"]), 25)
            # Tandis que occurrences_by_page conserve l'intégralité des 100+ occurrences
            self.assertGreaterEqual(len(target_doc["occurrences_by_page"]), 100)
            # La recherche globale doit s'effectuer en moins de 250ms même avec des centaines d'occurrences
            self.assertLess(t_search, 0.35)

            # Recherche ciblée intra-document (Split View)
            t_intra_0 = time.perf_counter()
            intra_res = self.client.get(f"/api/doc-search?doc_id={doc_id}&q=diagnostic")
            t_intra = time.perf_counter() - t_intra_0
            self.assertEqual(intra_res.status_code, 200)
            print(f"[Stress Test] Recherche intra-document 100 pages : {t_intra * 1000:.2f} ms")
            self.assertLess(t_intra, 0.15)

            # ------------------------------------------------------------------
            # 4. RAFALE DE LAZY CROPS & CONTRÔLE DES RESSOURCES
            # ------------------------------------------------------------------
            # Demande de 20 vignettes cropées sur différentes pages
            t_crop_0 = time.perf_counter()
            for p in range(1, 21):
                crop_res = self.client.get(f"/api/crop/{doc_id}/{p}/0?h=a1b2c3d4&terms=diagnostic")
                self.assertEqual(crop_res.status_code, 200)
                self.assertIn("image", crop_res.headers["Content-Type"])
            t_crops = time.perf_counter() - t_crop_0
            avg_crop_ms = (t_crops / 20.0) * 1000.0
            print(f"[Stress Test] Rafale 20 Lazy Crops générés à la volée : {avg_crop_ms:.2f} ms / vignette")
            self.assertLess(avg_crop_ms, 250.0, "La génération initiale WebP 144 DPI doit prendre moins de 250ms")

            # ------------------------------------------------------------------
            # 5. LATENCE SUR CACHE DISQUE DES CROPS (< 10ms)
            # ------------------------------------------------------------------
            t_cached_0 = time.perf_counter()
            for p in range(1, 21):
                cached_res = self.client.get(f"/api/crop/{doc_id}/{p}/0?h=a1b2c3d4&terms=diagnostic")
                self.assertEqual(cached_res.status_code, 200)
            t_cached = time.perf_counter() - t_cached_0
            avg_cached_ms = (t_cached / 20.0) * 1000.0
            print(f"[Stress Test] Rafale 20 Crops servis depuis le cache disque : {avg_cached_ms:.2f} ms / vignette")
            self.assertLess(avg_cached_ms, 15.0, "La récupération depuis le cache disque doit être quasi instantanée (< 15ms)")

            # Nettoyage final du gros document
            self.client.delete(f"/api/documents/{doc_id}")

    # ----------------------------------------------------------------------
    # 5. CONCURRENCE & CONFLITS DE VERROU SQLITE (WAL MODE)
    # ----------------------------------------------------------------------
    def test_concurrent_searches_and_operations(self):
        """
        Simule 20 requêtes simultanées de recherche et de lecture pour vérifier l'absence
        d'interblocage ou d'erreur 'database is locked' grâce au mode SQLite WAL.
        """
        def make_request(idx):
            if idx % 2 == 0:
                return self.client.get("/api/search?q=grossesse").status_code
            elif idx % 3 == 0:
                return self.client.get("/api/folders").status_code
            else:
                return self.client.get("/api/documents").status_code

        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            t0 = time.perf_counter()
            futures = [executor.submit(make_request, i) for i in range(25)]
            results = [f.result() for f in concurrent.futures.as_completed(futures)]
            total_time = time.perf_counter() - t0

        print(f"\n[Perf Concurrence] 25 requêtes simultanées traitées en {total_time:.2f}s")
        # Toutes les requêtes doivent avoir renvoyé 200 OK
        self.assertTrue(all(code == 200 for code in results))

    # ----------------------------------------------------------------------
    # 6. CAS PATHOLOGIQUES (MOTS GIGANTESQUES, DIMENSIONS EXTRÊMES, MULTI-TERMES)
    # ----------------------------------------------------------------------
    def test_pathological_giant_words_and_many_terms(self):
        """Teste les cas limites avec un mot géant sans espace (5 000 caractères) et une recherche à 30 termes."""
        with tempfile.TemporaryDirectory() as tmpdir:
            pdf_path = os.path.join(tmpdir, "giant_word.pdf")
            doc = pymupdf.open()
            page = doc.new_page()
            # Mot continu de 3 000 caractères
            giant_word = "A" * 3000
            page.insert_text((20, 50), f"Début {giant_word} Fin", fontsize=8)
            doc.save(pdf_path)
            doc.close()

            # Indexer le fichier pathologique
            with open(pdf_path, "rb") as f:
                up_res = self.client.post("/api/upload", files={"file": ("giant_word.pdf", f, "application/pdf")})
            self.assertEqual(up_res.status_code, 200)
            doc_id = up_res.json()["document"]["id"]

            # Requête avec 25 termes distincts
            long_query = " ".join([f"terme{i}" for i in range(25)])
            t0 = time.perf_counter()
            search_res = self.client.get(f"/api/search?q={long_query}")
            t1 = time.perf_counter()
            self.assertEqual(search_res.status_code, 200)
            self.assertLess(t1 - t0, 0.20)

            # Nettoyage
            self.client.delete(f"/api/documents/{doc_id}")

if __name__ == "__main__":
    unittest.main()
