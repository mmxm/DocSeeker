import unittest
import os
import tempfile
import json
import pymupdf
from unittest.mock import patch

from backend.crop_service import (
    match_word,
    get_query_hash,
    find_occurrences_on_page,
    generate_crop_image,
    get_or_generate_crop_on_demand,
    CACHE_DIR,
    DOCUMENTS_DIR
)

class TestUnitCropService(unittest.TestCase):
    def test_match_word(self):
        # 1. Cas vides
        self.assertFalse(match_word("", "terme"))
        self.assertFalse(match_word("mot", ""))
        self.assertFalse(match_word(None, "terme"))

        # 2. Correspondance exacte et préfixe
        self.assertTrue(match_word("grossesse", "grossesse"))
        self.assertTrue(match_word("grossesses", "grossesse"))

        # 3. Ponctuation et parenthèses
        self.assertTrue(match_word("(geu)", "geu"))
        self.assertTrue(match_word("«geu»", "geu"))
        self.assertTrue(match_word("mot;", "mot"))
        self.assertTrue(match_word("l'uterus", "uterus"))

        # 4. Sous-mots alphanumériques
        self.assertTrue(match_word("geu/fiv", "geu"))
        self.assertTrue(match_word("geu/fiv", "fiv"))
        self.assertTrue(match_word("pre-eclampsie", "eclampsie"))

        # 5. Sous-chaîne pour termes >= 4 caractères
        self.assertTrue(match_word("antigrossesse", "grossesse"))
        self.assertTrue(match_word("hypercholesterolemie", "cholesterol"))

        # 6. Rejets stricts pour termes courts (< 4 caractères) afin d'éviter les faux positifs
        self.assertFalse(match_word("large", "ar"))
        self.assertFalse(match_word("bateau", "te"))
        self.assertFalse(match_word("completement_different", "inconnu"))

    def test_get_query_hash(self):
        # Mêmes termes dans des ordres différents
        h1 = get_query_hash(["grossesse", "extra-utérine"])
        h2 = get_query_hash(["extra-utérine", "grossesse"])
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 8)

        # Termes d'une seule lettre ignorés
        h3 = get_query_hash(["a", "grossesse", "de"])
        h4 = get_query_hash(["grossesse", "de"])
        self.assertEqual(h3, h4)

        # Insensibilité aux accents et à la casse
        h5 = get_query_hash(["HÉMORRAGIE"])
        h6 = get_query_hash(["hemorragie"])
        self.assertEqual(h5, h6)

    def test_find_occurrences_on_page(self):
        # Mots fictifs sur une page [x0, y0, x1, y1, word, block_no, line_no]
        words_data = [
            [50.0, 100.0, 100.0, 115.0, "Grossesse", 0, 0],
            [105.0, 100.0, 160.0, 115.0, "normale", 0, 0],    # contigu sur même ligne (< 25pt)
            [50.0, 200.0, 110.0, 215.0, "Grossesse", 1, 0],   # autre bloc / ligne
            [50.0, 220.0, 120.0, 235.0, "pathologique", 1, 1],
        ]

        # 1. Termes vides
        self.assertEqual(find_occurrences_on_page(words_data, []), [])
        self.assertEqual(find_occurrences_on_page(words_data, ["a"]), [])

        # 2. Aucun mot correspondant
        self.assertEqual(find_occurrences_on_page(words_data, ["inconnu"]), [])

        # 3. Regroupement contigu
        occs = find_occurrences_on_page(words_data, ["grossesse", "normale"], page_height=800.0)
        self.assertGreaterEqual(len(occs), 2)
        # Première occurrence regroupe "Grossesse normale"
        self.assertEqual(occs[0]["text"], "Grossesse normale")
        self.assertEqual(occs[0]["distinct_terms_count"], 2)
        self.assertEqual(occs[0]["y_ratio"], round(100.0 / 800.0, 3))
        self.assertEqual(len(occs[0]["highlight_rects"]), 2)

        # Deuxième occurrence isolée
        self.assertEqual(occs[1]["text"], "Grossesse")
        self.assertEqual(occs[1]["distinct_terms_count"], 1)

        # 4. Gestion page_height <= 0
        occs_zero_height = find_occurrences_on_page(words_data, ["grossesse"], page_height=0.0)
        self.assertEqual(occs_zero_height[0]["y_ratio"], 0.0)

    def test_generate_crop_image_and_cache(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            test_doc_path = os.path.join(tmpdir, "test_crop.pdf")
            doc = pymupdf.open()
            page = doc.new_page(width=595, height=842)
            page.insert_text((100, 200), "Ceci est une hémorragie grave.", fontsize=14)
            doc.save(test_doc_path)
            doc.close()

            test_cache_dir = os.path.join(tmpdir, "cache")
            test_docs_dir = os.path.join(tmpdir, "docs")
            os.makedirs(test_docs_dir, exist_ok=True)
            import shutil
            shutil.copy(test_doc_path, os.path.join(test_docs_dir, "test_crop.pdf"))

            occ_data = {
                "occ_id": 0,
                "rect": (100.0, 190.0, 220.0, 210.0),
                "highlight_rects": [(100.0, 190.0, 220.0, 210.0)],
                "query_hash": "a1b2c3d4"
            }
            words_data = [
                [100.0, 190.0, 220.0, 210.0, "hémorragie", 0, 0]
            ]

            with patch("backend.crop_service.CACHE_DIR", test_cache_dir), \
                 patch("backend.crop_service.DOCUMENTS_DIR", test_docs_dir):

                # 1. Génération initiale
                crop_path = generate_crop_image(999, "test_crop.pdf", 1, occ_data, ["hémorragie"], words_data)
                self.assertTrue(os.path.exists(crop_path))
                self.assertTrue(crop_path.endswith(".webp") or crop_path.endswith(".jpg"))

                # 2. Utilisation du cache (fichier déjà présent)
                cached_path = generate_crop_image(999, "test_crop.pdf", 1, occ_data, ["hémorragie"], words_data)
                self.assertEqual(crop_path, cached_path)

                # 3. Cas d'erreur : fichier PDF introuvable (avec un occ_id non mis en cache)
                occ_uncached = dict(occ_data, occ_id=99)
                bad_path = generate_crop_image(999, "fichier_inexistant.pdf", 1, occ_uncached, ["hémorragie"], words_data)
                self.assertEqual(bad_path, "")

                # 4. Cas d'erreur : numéro de page hors limites
                occ_bad_page = dict(occ_data, occ_id=100)
                bad_page = generate_crop_image(999, "test_crop.pdf", 99, occ_bad_page, ["hémorragie"], words_data)
                self.assertEqual(bad_page, "")

    def test_get_or_generate_crop_on_demand_security_and_flow(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            test_cache_dir = os.path.join(tmpdir, "cache")
            with patch("backend.crop_service.CACHE_DIR", test_cache_dir):
                # 1. Tentative de Path Traversal bloquée ou neutralisée
                res_traversal = get_or_generate_crop_on_demand(1, 1, 0, "../../../../etc/passwd")
                # Doit être nettoyé en safe_hash="" sans sortir du répertoire de cache
                self.assertFalse("etc/passwd" in res_traversal)

                # 2. Document ou page introuvable en base
                res_not_found = get_or_generate_crop_on_demand(999999, 1, 0, "abcdef12")
                self.assertEqual(res_not_found, "")

if __name__ == "__main__":
    unittest.main()
