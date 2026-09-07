import unittest
import os
import io
import time
import tempfile
import shutil
import pymupdf
from fastapi.testclient import TestClient

from backend.main import app
from backend.database import get_db_connection
from backend.indexer import index_pdf_file, reindex_document, DOCUMENTS_DIR, COVERS_DIR, CACHE_DIR
from backend.search_engine import search_documents

class TestQAAdvancedLessons(unittest.TestCase):
    """
    Suite de tests avancés appliquant les 4 leçons fondamentales de l'ingénierie QA :
    1. Immutabilité temporelle des états (created_at vs updated_at).
    2. Cas limites et collisions d'identifiants à deux chiffres (occ_id 1 vs occ_id 10).
    3. Injection de panne et résilience (Fault Injection / Auto-guérison sur couverture manquante).
    4. Exigences métier réelles (mots-clés répartis sur des pages différentes du même document).
    """

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    # ----------------------------------------------------------------------
    # LEÇON 1 : VÉRIFICATION D'IMMUTABILITÉ TEMPORELLE (created_at vs updated_at)
    # ----------------------------------------------------------------------
    def test_lesson1_temporal_immutability_created_at(self):
        """
        Vérifie qu'une ré-indexation met à jour updated_at sans jamais écraser
        la date historique d'import original (created_at).
        """
        # Créer et indexer un PDF initial
        with tempfile.TemporaryDirectory() as tmpdir:
            pdf_path = os.path.join(tmpdir, "temporal_test.pdf")
            doc = pymupdf.open()
            page = doc.new_page()
            page.insert_text((50, 100), "Texte initial pour test temporel")
            doc.save(pdf_path)
            doc.close()

            # Copier dans DOCUMENTS_DIR pour indexation
            dest_pdf = os.path.join(DOCUMENTS_DIR, "temporal_test.pdf")
            shutil.copy(pdf_path, dest_pdf)

            try:
                res_idx = index_pdf_file(dest_pdf, "temporal_test.pdf", custom_title="Doc Temporel Initial")
                doc_id = res_idx["id"]

                conn = get_db_connection()
                row_initial = conn.execute("SELECT created_at, updated_at FROM documents WHERE id = ?", (doc_id,)).fetchone()
                initial_created_at = row_initial["created_at"]
                conn.close()

                # Petite pause pour garantir un écart de seconde
                time.sleep(1.1)

                # Ré-indexer le document
                reindexed = reindex_document(doc_id)
                self.assertIsNotNone(reindexed)

                # Assertion stricte QA : created_at NE DOIT PAS AVOIR CHANGÉ
                conn = get_db_connection()
                row_after = conn.execute("SELECT created_at, updated_at FROM documents WHERE id = ?", (doc_id,)).fetchone()
                conn.close()

                self.assertEqual(
                    row_after["created_at"],
                    initial_created_at,
                    f"Régression temporelle : created_at a été écrasé ({row_after['created_at']} != {initial_created_at})"
                )
                self.assertIsNotNone(row_after["updated_at"])
            finally:
                # Nettoyage
                from backend.indexer import remove_document
                remove_document(doc_id)

    # ----------------------------------------------------------------------
    # LEÇON 2 : TESTS AUX LIMITES & PRÉVENTION DES COLLISIONS (occ_id 1 vs occ_id 10)
    # ----------------------------------------------------------------------
    def test_lesson2_crop_cache_prefix_collision_1_vs_10(self):
        """
        Vérifie qu'en cas de présence de plus de 10 occurrences sur une page,
        la recherche d'occurrence 1 ne sert jamais le fichier d'occurrence 10.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            pdf_path = os.path.join(tmpdir, "collision_test.pdf")
            doc = pymupdf.open()
            page = doc.new_page(width=595, height=842)
            # Insérer 15 fois le mot cible sur différentes lignes
            for i in range(15):
                page.insert_text((50, 50 + i * 40), f"Ligne {i} avec le terme cible unique", fontsize=11)
            doc.save(pdf_path)
            doc.close()

            dest_pdf = os.path.join(DOCUMENTS_DIR, "collision_test.pdf")
            shutil.copy(pdf_path, dest_pdf)

            try:
                res_idx = index_pdf_file(dest_pdf, "collision_test.pdf")
                doc_id = res_idx["id"]

                # 1. Générer d'abord l'occurrence 10 dans le cache
                res_occ10 = self.client.get(f"/api/crop/{doc_id}/1/10?h=deadbeef&terms=terme")
                self.assertEqual(res_occ10.status_code, 200)

                # Vérifier que le fichier p1_occ10 existe sur disque
                doc_cache_dir = os.path.join(CACHE_DIR, f"doc_{doc_id}")
                files_before = os.listdir(doc_cache_dir)
                has_occ10_file = any(f.startswith("p1_occ10") for f in files_before)
                self.assertTrue(has_occ10_file, "Le fichier de l'occurrence 10 aurait dû être généré")

                # 2. Maintenant, demander l'occurrence 1
                res_occ1 = self.client.get(f"/api/crop/{doc_id}/1/1?h=deadbeef&terms=terme")
                self.assertEqual(res_occ1.status_code, 200)

                # 3. Assertion stricte QA : le fichier servi doit être p1_occ1 (avec délimiteur) et NON p1_occ10
                files_after = os.listdir(doc_cache_dir)
                has_occ1_strict = any(f.startswith("p1_occ1_") or f.startswith("p1_occ1.") for f in files_after)
                self.assertTrue(has_occ1_strict, "L'occurrence 1 doit avoir son propre fichier avec séparateur strict")

            finally:
                from backend.indexer import remove_document
                remove_document(doc_id)

    # ----------------------------------------------------------------------
    # LEÇON 3 : FAULT INJECTION (AUTO-GUÉRISON SUR COUVERTURE MANQUANTE)
    # ----------------------------------------------------------------------
    def test_lesson3_fault_injection_missing_cover_self_healing(self):
        """
        Injecte une panne (suppression intentionnelle de l'image de couverture sur disque)
        et vérifie que l'API est auto-guérissante (200 OK avec re-génération à la volée, au lieu d'une 404).
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            pdf_path = os.path.join(tmpdir, "fault_cover.pdf")
            doc = pymupdf.open()
            page = doc.new_page()
            page.insert_text((50, 100), "Première page pour couverture auto-guérissante")
            doc.save(pdf_path)
            doc.close()

            dest_pdf = os.path.join(DOCUMENTS_DIR, "fault_cover.pdf")
            shutil.copy(pdf_path, dest_pdf)

            try:
                res_idx = index_pdf_file(dest_pdf, "fault_cover.pdf")
                doc_id = res_idx["id"]

                # 1. Vérifier que la couverture existe initialement
                cover_webp = os.path.join(COVERS_DIR, f"{doc_id}.webp")
                cover_jpg = os.path.join(COVERS_DIR, f"{doc_id}.jpg")

                # 2. INJECTION DE PANNE : suppression brutale de la couverture sur le disque
                if os.path.exists(cover_webp):
                    os.remove(cover_webp)
                if os.path.exists(cover_jpg):
                    os.remove(cover_jpg)

                self.assertFalse(os.path.exists(cover_webp))
                self.assertFalse(os.path.exists(cover_jpg))

                # 3. L'utilisateur ou le navigateur demande la couverture
                res_cover = self.client.get(f"/api/cover/{doc_id}")

                # Assertion stricte QA : Ne doit JAMAIS renvoyer 404 si le PDF physique existe
                self.assertEqual(
                    res_cover.status_code, 200,
                    f"Défaut de résilience : /api/cover/{doc_id} a renvoyé {res_cover.status_code} au lieu de re-générer l'image"
                )
                self.assertIn("image", res_cover.headers["Content-Type"])

                # Vérifier que le fichier a bien été restauré sur le disque
                cover_restored = os.path.exists(cover_webp) or os.path.exists(cover_jpg)
                self.assertTrue(cover_restored, "L'image de couverture aurait dû être re-créée sur le disque")

            finally:
                from backend.indexer import remove_document
                remove_document(doc_id)

    # ----------------------------------------------------------------------
    # LEÇON 4 : EXIGENCES MÉTIER RÉELLES (MOTS-CLÉS SUR DES PAGES DISTINCTES)
    # ----------------------------------------------------------------------
    def test_lesson4_multipage_keyword_dispersion_ranking(self):
        """
        Vérifie qu'un document traitant de TOUS les mots-clés de la recherche
        (mais répartis sur des pages différentes) obtient le statut 'matched_all_terms'
        et le bonus de pertinence (+1000 points), surpassant un document ne traitant que d'un seul mot.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            # Document A : Contient 'pédiatrie' en page 1 et 'néonatologie' en page 2 (aucun sur la même page)
            pdf_a_path = os.path.join(tmpdir, "doc_a_multipage.pdf")
            doc_a = pymupdf.open()
            p1 = doc_a.new_page()
            p1.insert_text((50, 100), "Chapitre 1 : Notions fondamentales de pédiatrie générale.")
            p2 = doc_a.new_page()
            p2.insert_text((50, 100), "Chapitre 2 : Soins intensifs de néonatologie moderne.")
            doc_a.save(pdf_a_path)
            doc_a.close()

            # Document B : Ne contient que 'pédiatrie' (sur 1 page)
            pdf_b_path = os.path.join(tmpdir, "doc_b_singlepage.pdf")
            doc_b = pymupdf.open()
            pb1 = doc_b.new_page()
            pb1.insert_text((50, 100), "Manuel exclusif de pédiatrie clinique générale.")
            doc_b.save(pdf_b_path)
            doc_b.close()

            dest_a = os.path.join(DOCUMENTS_DIR, "doc_a_multipage.pdf")
            dest_b = os.path.join(DOCUMENTS_DIR, "doc_b_singlepage.pdf")
            shutil.copy(pdf_a_path, dest_a)
            shutil.copy(pdf_b_path, dest_b)

            doc_a_id = None
            doc_b_id = None
            try:
                res_a = index_pdf_file(dest_a, "doc_a_multipage.pdf", custom_title="Traité Pédiatrie et Néonatologie")
                res_b = index_pdf_file(dest_b, "doc_b_singlepage.pdf", custom_title="Traité Pédiatrie Seule")
                doc_a_id = res_a["id"]
                doc_b_id = res_b["id"]

                # Recherche multi-termes sur les deux mots
                search_res = self.client.get("/api/search?q=pédiatrie néonatologie")
                self.assertEqual(search_res.status_code, 200)
                results = search_res.json().get("results", [])

                # Trouver le document A
                result_doc_a = next((d for d in results if d["id"] == doc_a_id), None)
                self.assertIsNotNone(result_doc_a, "Le document A aurait dû être trouvé dans les résultats")

                # Assertion stricte QA : matched_all_terms DOIT être True pour Doc A
                self.assertTrue(
                    result_doc_a["matched_all_terms"],
                    "Défaut de ranking : Le document A contient bien tous les mots recherchés (sur des pages différentes) mais matched_all_terms est False"
                )

                # Le score de Doc A doit bénéficier du bonus (+1000 points)
                self.assertGreater(
                    result_doc_a["relevance_score"], 1000.0,
                    f"Le score ({result_doc_a['relevance_score']}) aurait dû inclure le bonus de 1000 points"
                )

                # Le document A (complet) doit être classé DEVANT le document B (partiel)
                top_result = results[0]
                self.assertEqual(
                    top_result["id"], doc_a_id,
                    f"Inversion de classement : Doc A (complet) aurait dû être en tête, trouvé ID {top_result['id']}"
                )

            finally:
                from backend.indexer import remove_document
                if doc_a_id:
                    remove_document(doc_a_id)
                if doc_b_id:
                    remove_document(doc_b_id)

if __name__ == "__main__":
    unittest.main()
