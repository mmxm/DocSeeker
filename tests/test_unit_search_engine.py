import unittest
import os
import tempfile
import json
import shutil
from unittest.mock import patch

from backend.database import init_db, get_db_connection
from backend.search_engine import (
    sanitize_fts_query,
    get_folder_and_subfolder_ids,
    search_titles,
    search_documents,
    search_within_document,
    MAX_OCCURRENCES_PER_DOC
)

class TestUnitSearchEngine(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.test_dir, "test.sqlite")
        with patch("backend.database.DB_PATH", self.db_path):
            init_db()
            self._seed_data()

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def _seed_data(self):
        conn = get_db_connection()
        cursor = conn.cursor()

        # Créer arborescence de dossiers : Racine -> Dossier Parent -> Dossier Enfant -> Dossier Petit-Enfant
        cursor.execute("INSERT INTO folders (name, parent_id) VALUES ('Dossier Parent', NULL);")
        self.parent_folder_id = cursor.lastrowid

        cursor.execute("INSERT INTO folders (name, parent_id) VALUES ('Sous Dossier 1', ?);", (self.parent_folder_id,))
        self.sub_folder_id = cursor.lastrowid

        cursor.execute("INSERT INTO folders (name, parent_id) VALUES ('Sous Dossier 2', ?);", (self.sub_folder_id,))
        self.sub_sub_folder_id = cursor.lastrowid

        cursor.execute("INSERT INTO folders (name, parent_id) VALUES ('Dossier Isole', NULL);")
        self.isolated_folder_id = cursor.lastrowid

        # Insérer 3 documents
        # Doc 1 : Dans Dossier Parent
        cursor.execute("""
            INSERT INTO documents (filename, title, folder_id, total_pages)
            VALUES ('obstetrique_1.pdf', 'Obstetrique Generale', ?, 3);
        """, (self.parent_folder_id,))
        self.doc1_id = cursor.lastrowid

        # Doc 2 : Dans Sous Dossier 2 (arborescence profonde)
        cursor.execute("""
            INSERT INTO documents (filename, title, folder_id, total_pages)
            VALUES ('hemorragie_delivrance.pdf', 'Complications Delivrance', ?, 2);
        """, (self.sub_sub_folder_id,))
        self.doc2_id = cursor.lastrowid

        # Doc 3 : Dans Dossier Isolé
        cursor.execute("""
            INSERT INTO documents (filename, title, folder_id, total_pages)
            VALUES ('pediatrie.pdf', 'Pediatrie Generale', ?, 1);
        """, (self.isolated_folder_id,))
        self.doc3_id = cursor.lastrowid

        # Insérer les pages et entrées FTS
        # Doc 1 : contient "obstétrique", "grossesse", "hémorragie"
        w1 = [[10.0, 10.0, 80.0, 25.0, "Hémorragie", 0, 0], [90.0, 10.0, 150.0, 25.0, "sévère", 0, 0]]
        cursor.execute("INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (?, 1, 'Hémorragie sévère lors de la grossesse.', ?);",
                       (self.doc1_id, json.dumps(w1)))
        cursor.execute("INSERT INTO pages_fts (doc_id, page_number, text_content) VALUES (?, 1, 'Hémorragie sévère lors de la grossesse.');",
                       (self.doc1_id,))

        # Doc 2 : contient "hémorragie" et "délivrance" sur page 1 et page 2
        w2_p1 = [[10.0, 10.0, 80.0, 25.0, "Hémorragie", 0, 0], [90.0, 10.0, 160.0, 25.0, "délivrance", 0, 0]]
        cursor.execute("INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (?, 1, 'Prise en charge de hémorragie délivrance immédiate.', ?);",
                       (self.doc2_id, json.dumps(w2_p1)))
        cursor.execute("INSERT INTO pages_fts (doc_id, page_number, text_content) VALUES (?, 1, 'Prise en charge de hémorragie délivrance immédiate.');",
                       (self.doc2_id,))

        w2_p2 = [[10.0, 10.0, 70.0, 25.0, "Délivrance", 0, 0]]
        cursor.execute("INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (?, 2, 'Surveillance après délivrance.', ?);",
                       (self.doc2_id, json.dumps(w2_p2)))
        cursor.execute("INSERT INTO pages_fts (doc_id, page_number, text_content) VALUES (?, 2, 'Surveillance après délivrance.');",
                       (self.doc2_id,))

        # Doc 3 : contient "pédiatrie"
        w3 = [[10.0, 10.0, 60.0, 25.0, "Pédiatrie", 0, 0]]
        cursor.execute("INSERT INTO pages (doc_id, page_number, text_content, words_json) VALUES (?, 1, 'Manuel de pédiatrie clinique.', ?);",
                       (self.doc3_id, json.dumps(w3)))
        cursor.execute("INSERT INTO pages_fts (doc_id, page_number, text_content) VALUES (?, 1, 'Manuel de pédiatrie clinique.');",
                       (self.doc3_id,))

        conn.commit()
        conn.close()

    def test_sanitize_fts_query(self):
        self.assertEqual(sanitize_fts_query("hémorragie, délivrance!"), ["hémorragie", "délivrance"])
        self.assertEqual(sanitize_fts_query("   "), [])
        self.assertEqual(sanitize_fts_query("a b c"), ["a", "b", "c"])
        self.assertEqual(sanitize_fts_query("GEU (grossesse extra-utérine)"), ["GEU", "grossesse", "extra", "utérine"])

    def test_get_folder_and_subfolder_ids(self):
        with patch("backend.database.DB_PATH", self.db_path):
            # Le dossier parent doit inclure lui-même, son sous-dossier, et son sous-sous-dossier
            ids = get_folder_and_subfolder_ids(self.parent_folder_id)
            self.assertEqual(set(ids), {self.parent_folder_id, self.sub_folder_id, self.sub_sub_folder_id})

            # Le sous-sous dossier n'a pas d'enfants
            ids_leaf = get_folder_and_subfolder_ids(self.sub_sub_folder_id)
            self.assertEqual(ids_leaf, [self.sub_sub_folder_id])

    def test_search_titles(self):
        with patch("backend.database.DB_PATH", self.db_path):
            # 1. Requête vide
            res_empty = search_titles("")
            self.assertEqual(res_empty["total_documents"], 0)

            # 2. Recherche titre match
            res = search_titles("obstetrique")
            self.assertGreaterEqual(res["total_documents"], 1)
            self.assertEqual(res["results"][0]["id"], self.doc1_id)

            # 3. Recherche avec filtre dossier (incluant sous-dossiers récursifs)
            res_filtered = search_titles("delivrance", folder_id=self.parent_folder_id)
            self.assertEqual(res_filtered["total_documents"], 1)
            self.assertEqual(res_filtered["results"][0]["id"], self.doc2_id)

            # 4. Recherche avec filtre dossier isolé (ne doit pas trouver doc2)
            res_no_match = search_titles("delivrance", folder_id=self.isolated_folder_id)
            self.assertEqual(res_no_match["total_documents"], 0)

            # 5. Recherche singulier / pluriel / préfixe dans les titres (ex: 'complication' vs 'Complications Delivrance')
            res_singular = search_titles("complication")
            self.assertGreaterEqual(res_singular["total_documents"], 1)
            self.assertEqual(res_singular["results"][0]["id"], self.doc2_id)

            res_plural = search_titles("complications")
            self.assertGreaterEqual(res_plural["total_documents"], 1)
            self.assertEqual(res_plural["results"][0]["id"], self.doc2_id)

            res_prefix = search_titles("complica")
            self.assertGreaterEqual(res_prefix["total_documents"], 1)
            self.assertEqual(res_prefix["results"][0]["id"], self.doc2_id)

    def test_search_documents_ranking_and_filters(self):
        with patch("backend.database.DB_PATH", self.db_path):
            # 1. Recherche multi-termes : doc2 contient "hémorragie" et "délivrance" (AND match -> prioritaire)
            res = search_documents("hémorragie délivrance")
            self.assertGreaterEqual(res["total_documents"], 1)
            top_doc = res["results"][0]
            self.assertEqual(top_doc["id"], self.doc2_id)
            self.assertTrue(top_doc["matched_all_terms"])
            self.assertGreater(top_doc["relevance_score"], 1000.0)

            # Vérifier la séparation vignettes (top ruban) vs occurrences_by_page (chronologique)
            self.assertIn("vignettes", top_doc)
            self.assertIn("occurrences_by_page", top_doc)
            self.assertLessEqual(len(top_doc["vignettes"]), MAX_OCCURRENCES_PER_DOC)

            # 2. Filtrage par dossier récursif
            res_sub = search_documents("hémorragie", folder_id=self.sub_folder_id)
            self.assertEqual(res_sub["total_documents"], 1)
            self.assertEqual(res_sub["results"][0]["id"], self.doc2_id)

            # 3. Mode titles_only
            res_titles = search_documents("pediatrie", titles_only=True)
            self.assertEqual(res_titles["total_documents"], 1)
            self.assertEqual(res_titles["results"][0]["id"], self.doc3_id)
            self.assertEqual(res_titles["results"][0]["total_occurrences"], 0)

            # 4. Terme inexistant
            res_zero = search_documents("introuvablexyz")
            self.assertEqual(res_zero["total_documents"], 0)

    def test_search_within_document(self):
        with patch("backend.database.DB_PATH", self.db_path):
            # 1. Recherche dans doc2
            res = search_within_document(self.doc2_id, "délivrance")
            self.assertEqual(res["doc_id"], self.doc2_id)
            self.assertGreaterEqual(res["total_occurrences"], 1)
            pages_found = [o["page_number"] for o in res["occurrences"]]
            self.assertIn(1, pages_found)
            self.assertIn(2, pages_found)

            # 2. Terme non présent dans ce document
            res_none = search_within_document(self.doc2_id, "pédiatrie")
            self.assertEqual(res_none["total_occurrences"], 0)

            # 3. Requête vide
            res_empty = search_within_document(self.doc2_id, "")
            self.assertEqual(res_empty["total_occurrences"], 0)

if __name__ == "__main__":
    unittest.main()
