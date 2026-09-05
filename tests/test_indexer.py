import unittest
import os
import tempfile
import pymupdf
from backend.indexer import index_pdf_file, compute_file_hash, find_duplicate_by_hash, remove_document, COVERS_DIR
from backend.database import get_db_connection

class TestIndexer(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.test_pdf = os.path.join(self.temp_dir, "test_doc.pdf")
        
        # Créer un PDF d'exemple
        doc = pymupdf.open()
        page1 = doc.new_page()
        page1.insert_text((50, 100), "Premier chapitre : Hémorragie obstétricale et prise en charge.", fontsize=12)
        page2 = doc.new_page()
        page2.insert_text((50, 100), "Deuxième chapitre : Traitement de l'hémorragie de la délivrance.", fontsize=12)
        doc.save(self.test_pdf)
        doc.close()

    def test_compute_file_hash(self):
        h1 = compute_file_hash(self.test_pdf)
        self.assertIsInstance(h1, str)
        self.assertEqual(len(h1), 64) # SHA-256

    def test_index_and_duplicate_detection(self):
        filename = "test_doc_unique.pdf"
        res = index_pdf_file(self.test_pdf, filename, custom_title="Document de Test Obstétrique")
        doc_id = res["id"]
        
        self.assertEqual(res["title"], "Document de Test Obstétrique")
        self.assertEqual(res["total_pages"], 2)
        
        # Vérifier que la couverture est créée
        cover_path = os.path.join(COVERS_DIR, f"{doc_id}.jpg")
        self.assertTrue(os.path.exists(cover_path))
        
        # Vérifier la détection de doublon
        h = compute_file_hash(self.test_pdf)
        dup = find_duplicate_by_hash(h)
        self.assertIsNotNone(dup)
        self.assertEqual(dup["id"], doc_id)
        
        # Nettoyage
        remove_document(doc_id)
        self.assertFalse(os.path.exists(cover_path))

if __name__ == "__main__":
    unittest.main()
