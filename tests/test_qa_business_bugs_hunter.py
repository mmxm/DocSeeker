import unittest
import os
import io
import json
import tempfile
import shutil
import pymupdf
from fastapi.testclient import TestClient

from backend.main import app
from backend.database import get_db_connection
from backend.indexer import index_pdf_file, remove_document, DOCUMENTS_DIR, COVERS_DIR
from backend.search_engine import sanitize_fts_query, search_titles

class TestQABusinessBugsHunter(unittest.TestCase):
    """
    Suite de tests QA débusquant les bugs métiers, fonctionnels et de cohérence.
    Chaque test documente et formalise un comportement attendu non satisfait
    par l'implémentation actuelle, destiné à être résolu par l'équipe de développement.
    """

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def setUp(self):
        import gc
        gc.collect()

    def tearDown(self):
        import gc
        gc.collect()

    # ----------------------------------------------------------------------
    # BUG 6 : Crash HTTP 500 sur création de dossier avec parent_id inexistant
    # ----------------------------------------------------------------------
    def test_bug_crash_500_folder_invalid_parent(self):
        """
        [Métier/API] Créer un dossier avec un parent_id inexistant doit renvoyer
        une erreur HTTP 400/404 propre au lieu d'un crash non intercepté HTTP 500
        (IntegrityError SQLite FOREIGN KEY constraint failed).
        """
        response = self.client.post("/api/folders", json={
            "name": "Sous-dossier Orphelin",
            "parent_id": 999999,
            "color": "#ef4444"
        })
        self.assertIn(
            response.status_code,
            [400, 404],
            f"Attendu 400 ou 404 lors de la création d'un dossier avec parent inexistant, reçu {response.status_code}: {response.text}"
        )

    # ----------------------------------------------------------------------
    # BUG 7 : Upload avec folder_id inexistant crée des entrées orphelines en base
    # ----------------------------------------------------------------------
    def test_bug_upload_invalid_folder_leaves_no_orphaned_doc(self):
        """
        [Métier/Intégrité] Téléverser un PDF avec un folder_id inexistant ne doit PAS :
        1. Renvoyer HTTP 500.
        2. Laisser une entrée document/pages/FTS orpheline en base sans PDF sur disque.
        """
        doc = pymupdf.open()
        page = doc.new_page()
        page.insert_text((50, 100), "Document test pour dossier invalide")
        pdf_bytes = doc.tobytes()
        doc.close()

        fake_folder_id = 888888
        response = self.client.post(
            "/api/upload",
            files={"file": ("invalid_folder_test.pdf", io.BytesIO(pdf_bytes), "application/pdf")},
            data={"title": "Test Dossier Invalide", "folder_id": str(fake_folder_id)}
        )

        # L'API doit refuser avec 400/404
        self.assertIn(
            response.status_code,
            [400, 404],
            f"Attendu 400 ou 404 pour folder_id inexistant lors de l'upload, reçu {response.status_code}"
        )

        # Vérifier qu'aucun document fantôme n'a été inséré en base sans fichier
        conn = get_db_connection()
        orphaned = conn.execute("SELECT id, filename FROM documents WHERE title = 'Test Dossier Invalide'").fetchone()
        conn.close()
        self.assertIsNone(
            orphaned,
            "Un document orphelin a été créé en base de données alors que l'upload a échoué !"
        )

    # ----------------------------------------------------------------------
    # BUG 8 : Incohérence DELETE sur dossier inexistant renvoie 200
    # ----------------------------------------------------------------------
    def test_bug_delete_non_existent_folder_returns_404(self):
        """
        [Cohérence API] Supprimer un dossier qui n'existe pas doit renvoyer 404 Not Found
        (comme pour /api/documents/{id}), et non 200 OK avec message de succès.
        """
        response = self.client.delete("/api/folders/777777")
        self.assertEqual(
            response.status_code,
            404,
            f"Supprimer un dossier inexistant doit retourner 404, reçu {response.status_code}: {response.text}"
        )

    # ----------------------------------------------------------------------
    # BUG 9 : Perte des termes médicaux critiques mono-caractères / chiffres
    # ----------------------------------------------------------------------
    def test_bug_medical_single_letter_digit_not_stripped(self):
        """
        [Métier Médical] Dans la recherche médicale, des termes d'une lettre ou d'un chiffre
        sont discriminants : 'Hépatite B' vs 'Hépatite C', 'Diabète type 1' vs 'Diabète type 2',
        'Vitamine D'. sanitize_fts_query ne doit pas filtrer ces termes essentiels.
        """
        terms_b = sanitize_fts_query("Hépatite B")
        terms_c = sanitize_fts_query("Hépatite C")
        self.assertIn("B", terms_b, "Le discriminant 'B' dans 'Hépatite B' a été supprimé !")
        self.assertIn("C", terms_c, "Le discriminant 'C' dans 'Hépatite C' a été supprimé !")
        self.assertNotEqual(terms_b, terms_c, "Les recherches 'Hépatite B' et 'Hépatite C' sont devenues identiques !")

        terms_t1 = sanitize_fts_query("Diabète type 1")
        terms_t2 = sanitize_fts_query("Diabète type 2")
        self.assertIn("1", terms_t1, "Le chiffre '1' dans 'Diabète type 1' a été supprimé !")
        self.assertIn("2", terms_t2, "Le chiffre '2' dans 'Diabète type 2' a été supprimé !")
        self.assertNotEqual(terms_t1, terms_t2, "Les recherches 'Diabète type 1' et 'Diabète type 2' sont devenues identiques !")

    # ----------------------------------------------------------------------
    # BUG 10 : Pollution par sous-chaîne arbitraire dans search_titles
    # ----------------------------------------------------------------------
    def test_bug_search_titles_word_boundary(self):
        """
        [Métier Recherche] search_titles ne doit pas considérer un mot comme présent
        s'il ne s'agit que d'une sous-chaîne aléatoire au milieu d'un autre mot
        (ex: terme 'car' matchant 'brancardier', ou 'en' matchant 'femme enceinte').
        """
        doc_id = None
        with tempfile.TemporaryDirectory() as tmpdir:
            pdf_path = os.path.join(tmpdir, "brancardier.pdf")
            doc = pymupdf.open()
            page = doc.new_page()
            page.insert_text((50, 100), "Fiche métier brancardier")
            doc.save(pdf_path)
            doc.close()

            dest = os.path.join(DOCUMENTS_DIR, "brancardier.pdf")
            shutil.copy(pdf_path, dest)
            try:
                res_idx = index_pdf_file(dest, "brancardier.pdf", custom_title="Fiche du brancardier")
                doc_id = res_idx["id"]

                # Recherche du terme 'car' (voiture/autocar) dans les titres
                results = search_titles("car")
                matched_ids = [r["id"] for r in results["results"]]

                self.assertNotIn(
                    doc_id,
                    matched_ids,
                    "Le titre 'Fiche du brancardier' a été faussement apparié pour la recherche 'car' !"
                )
            finally:
                if doc_id is not None:
                    remove_document(doc_id)

    # ----------------------------------------------------------------------
    # BUG 11 : Compte faussé moved_count dans batch_move_documents
    # ----------------------------------------------------------------------
    def test_bug_batch_move_accurate_moved_count(self):
        """
        [Métier Données] /api/documents/batch-move doit renvoyer le nombre réel de documents
        mis à jour (cursor.rowcount) et non aveuglément len(doc_ids) envoyés.
        """
        response = self.client.post("/api/documents/batch-move", json={
            "doc_ids": [999981, 999982, 999983],
            "folder_id": None
        })
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(
            data["moved_count"],
            0,
            f"batch-move a prétendu avoir déplacé {data['moved_count']} documents alors qu'aucun n'existait !"
        )

    # ----------------------------------------------------------------------
    # BUG 12 : Range HTTP inversé (start > end) renvoie du négatif au lieu de 416
    # ----------------------------------------------------------------------
    def test_bug_pdf_stream_invalid_reversed_range_returns_416(self):
        """
        [Conformité RFC 7233 / 9110] Une requête avec Header 'Range: bytes=500-200'
        (start > end) doit renvoyer 416 Range Not Satisfiable et non 206 avec Content-Length négatif.
        """
        # Trouver un document existant avec fichier physique présent sur le disque
        conn = get_db_connection()
        rows = conn.execute("SELECT id, filename FROM documents WHERE status = 'ready'").fetchall()
        conn.close()

        valid_doc_id = None
        for r in rows:
            if os.path.exists(os.path.join(DOCUMENTS_DIR, r["filename"])):
                valid_doc_id = r["id"]
                break

        if valid_doc_id is not None:
            response = self.client.get(f"/api/pdf/{valid_doc_id}", headers={"Range": "bytes=500-200"})
            self.assertEqual(
                response.status_code,
                416,
                f"Range HTTP invalide inversé bytes=500-200 doit renvoyer 416, reçu {response.status_code}"
            )

    # ----------------------------------------------------------------------
    # BUG 13 : Recherche interne doc_search sur doc inexistant renvoie 200
    # ----------------------------------------------------------------------
    def test_bug_doc_search_non_existent_doc_returns_404(self):
        """
        [Cohérence API] /api/doc-search avec un doc_id inexistant doit renvoyer 404
        pour notifier le client que le document n'existe pas, et non 200 avec 0 occurrences.
        """
        response = self.client.get("/api/doc-search?doc_id=999999&q=test")
        self.assertEqual(
            response.status_code,
            404,
            f"/api/doc-search pour document inexistant doit retourner 404, reçu {response.status_code}"
        )

    # ----------------------------------------------------------------------
    # BUG 14 : Fuite de fichiers orphelins WebP lors de remove_document
    # ----------------------------------------------------------------------
    def test_bug_remove_document_cleans_webp_cover(self):
        """
        [Résilience / Nettoyage disque] remove_document doit supprimer TOUTES les variantes
        de la couverture (notamment .webp généré lors de l'indexation) et non seulement le .jpg.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            pdf_path = os.path.join(tmpdir, "cover_cleanup_test.pdf")
            doc = pymupdf.open()
            page = doc.new_page()
            page.insert_text((50, 100), "Test couverture WebP orpheline")
            doc.save(pdf_path)
            doc.close()

            dest = os.path.join(DOCUMENTS_DIR, "cover_cleanup_test.pdf")
            shutil.copy(pdf_path, dest)
            res_idx = index_pdf_file(dest, "cover_cleanup_test.pdf")
            doc_id = res_idx["id"]

            webp_path = os.path.join(COVERS_DIR, f"{doc_id}.webp")
            # S'assurer que le webp a bien été créé
            self.assertTrue(os.path.exists(webp_path), f"Le fichier couverture webp {webp_path} devrait exister.")

            # Supprimer le document
            remove_document(doc_id)

            # Vérifier que le fichier webp n'a pas été laissé orphelin
            self.assertFalse(
                os.path.exists(webp_path),
                f"Le fichier couverture webp {webp_path} est resté orphelin sur disque après remove_document !"
            )
            if os.path.exists(webp_path):
                try:
                    os.remove(webp_path)
                except OSError:
                    pass

    # ----------------------------------------------------------------------
    # BUG 22 : Échec de la recherche par titre sur singulier / pluriel et préfixes
    # ----------------------------------------------------------------------
    def test_bug_search_titles_singular_plural_and_prefix(self):
        """
        [Métier Recherche] search_titles avec le filtre 'Titres uniquement' ne doit pas
        échouer lorsqu'un utilisateur cherche au singulier un mot présent au pluriel dans le titre
        (ex: 'complication' vs 'complications'), ni vice-versa (ex: 'examens' vs 'examen'),
        ni lors de la frappe progressive de préfixe (ex: 'complica').
        Tout en respectant les frontières de mot pour ne pas réintroduire le Bug 10 ('car' vs 'brancardier').
        """
        doc1_id = None
        doc2_id = None
        with tempfile.TemporaryDirectory() as tmpdir:
            # Document 1 avec mot au pluriel dans le titre : "Principales Complications de la Grossesse"
            p1 = os.path.join(tmpdir, "doc_complications.pdf")
            d1 = pymupdf.open()
            page1 = d1.new_page()
            page1.insert_text((50, 100), "Contenu médical complications")
            d1.save(p1)
            d1.close()

            # Document 2 avec mot au singulier dans le titre : "Examen Clinique de l'Enfant"
            p2 = os.path.join(tmpdir, "doc_examen.pdf")
            d2 = pymupdf.open()
            page2 = d2.new_page()
            page2.insert_text((50, 100), "Contenu pédiatrie examen")
            d2.save(p2)
            d2.close()

            dest1 = os.path.join(DOCUMENTS_DIR, "doc_complications.pdf")
            dest2 = os.path.join(DOCUMENTS_DIR, "doc_examen.pdf")
            shutil.copy(p1, dest1)
            shutil.copy(p2, dest2)

            try:
                res1 = index_pdf_file(dest1, "doc_complications.pdf", custom_title="Principales Complications de la Grossesse")
                doc1_id = res1["id"]
                res2 = index_pdf_file(dest2, "doc_examen.pdf", custom_title="Examen Clinique de l'Enfant")
                doc2_id = res2["id"]

                # 1. Recherche au singulier ('complication') doit trouver le titre au pluriel ('Complications')
                res_sing = search_titles("complication")
                ids_sing = [r["id"] for r in res_sing["results"]]
                self.assertIn(
                    doc1_id,
                    ids_sing,
                    "La recherche au singulier 'complication' n'a pas trouvé le titre contenant 'Complications' !"
                )

                # 2. Recherche au pluriel ('complications') doit trouver le document
                res_plur = search_titles("complications")
                ids_plur = [r["id"] for r in res_plur["results"]]
                self.assertIn(
                    doc1_id,
                    ids_plur,
                    "La recherche au pluriel 'complications' n'a pas trouvé le titre contenant 'Complications' !"
                )

                # 3. Recherche par préfixe ('complica') doit trouver le document
                res_pref = search_titles("complica")
                ids_pref = [r["id"] for r in res_pref["results"]]
                self.assertIn(
                    doc1_id,
                    ids_pref,
                    "La recherche progressive 'complica' n'a pas trouvé le titre contenant 'Complications' !"
                )

                # 4. Recherche au pluriel ('examens') doit trouver le titre au singulier ('Examen Clinique')
                res_inv = search_titles("examens")
                ids_inv = [r["id"] for r in res_inv["results"]]
                self.assertIn(
                    doc2_id,
                    ids_inv,
                    "La recherche au pluriel 'examens' n'a pas trouvé le titre au singulier 'Examen Clinique' !"
                )

                # 5. Via l'API REST endpoint /api/search?q=...&titles_only=true
                api_res_sing = self.client.get("/api/search?q=complication&titles_only=true")
                self.assertEqual(api_res_sing.status_code, 200)
                api_ids_sing = [r["id"] for r in api_res_sing.json()["results"]]
                self.assertIn(doc1_id, api_ids_sing)

                api_res_plur = self.client.get("/api/search?q=complications&titles_only=true")
                self.assertEqual(api_res_plur.status_code, 200)
                api_ids_plur = [r["id"] for r in api_res_plur.json()["results"]]
                self.assertIn(doc1_id, api_ids_plur)

            finally:
                if doc1_id is not None:
                    remove_document(doc1_id)
                if doc2_id is not None:
                    remove_document(doc2_id)

if __name__ == "__main__":
    unittest.main()
