import unittest
import os
from backend.search_engine import search_documents, search_within_document, sanitize_fts_query
from backend.crop_service import get_query_hash, find_occurrences_on_page

class TestSearchEngine(unittest.TestCase):
    def test_sanitize_fts_query(self):
        self.assertEqual(sanitize_fts_query("hémorragie délivrance!"), ["hémorragie", "délivrance"])
        self.assertEqual(sanitize_fts_query("a"), [])
        self.assertEqual(sanitize_fts_query("grossesse extra-utérine"), ["grossesse", "extra", "utérine"])

    def test_query_hash_consistency(self):
        h1 = get_query_hash(["hémorragie", "délivrance"])
        h2 = get_query_hash(["délivrance", "hémorragie"])
        # Doit être identique quel que soit l'ordre
        self.assertEqual(h1, h2)

    def test_search_results_structure_and_sorting(self):
        # Recherche sur un terme existant dans les PDF réels
        res = search_documents("hémorragie délivrance")
        self.assertIn("results", res)
        self.assertGreater(res["total_documents"], 0)
        
        from backend.search_engine import MAX_OCCURRENCES_PER_DOC
        top_doc = res["results"][0]
        # Vérifier que les vignettes du ruban sont plafonnées à MAX_OCCURRENCES_PER_DOC
        self.assertLessEqual(len(top_doc["vignettes"]), MAX_OCCURRENCES_PER_DOC)
        
        # Vérifier que occurrences_by_page conserve l'intégralité
        self.assertGreaterEqual(len(top_doc["occurrences_by_page"]), len(top_doc["vignettes"]))
        
        # Vérifier les coordonnées spatiales
        first_occ = top_doc["occurrences_by_page"][0]
        self.assertIn("y_ratio", first_occ)
        self.assertIn("rect", first_occ)
        self.assertEqual(len(first_occ["rect"]), 4)

    def test_search_within_document(self):
        # Chercher dans le document ID 2
        res = search_within_document(2, "hémorragie")
        self.assertEqual(res["doc_id"], 2)
        self.assertIn("occurrences", res)
        if res["total_occurrences"] > 0:
            occ = res["occurrences"][0]
            self.assertIn("page_number", occ)
            self.assertIn("rect", occ)

if __name__ == "__main__":
    unittest.main()
