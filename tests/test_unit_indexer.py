import unittest
import os
import tempfile
import shutil
import pymupdf
from unittest.mock import patch

from backend.database import init_db, get_db_connection
from backend.indexer import (
    compute_file_hash,
    find_duplicate_by_hash,
    index_pdf_file,
    remove_document,
    reindex_document,
    scan_and_sync_documents
)

class TestUnitIndexer(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.test_dir, "test.sqlite")
        self.docs_dir = os.path.join(self.test_dir, "documents")
        self.cache_dir = os.path.join(self.test_dir, "cache")
        self.covers_dir = os.path.join(self.cache_dir, "covers")
        os.makedirs(self.docs_dir, exist_ok=True)
        os.makedirs(self.covers_dir, exist_ok=True)

        # Initialiser la base isolée
        with patch("backend.database.DB_PATH", self.db_path):
            init_db()

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def _create_sample_pdf(self, filename="sample.pdf", title_meta="Sample Document", text="Contenu médical test.") -> str:
        pdf_path = os.path.join(self.docs_dir, filename)
        doc = pymupdf.open()
        if title_meta:
            doc.set_metadata({"title": title_meta})
        page = doc.new_page(width=595, height=842)
        page.insert_text((50, 100), text, fontsize=12)
        doc.save(pdf_path)
        doc.close()
        return pdf_path

    def test_compute_file_hash(self):
        pdf_path = self._create_sample_pdf("hash_test.pdf")
        h1 = compute_file_hash(pdf_path)
        self.assertIsInstance(h1, str)
        self.assertEqual(len(h1), 64)

        # Même contenu -> même hash
        h2 = compute_file_hash(pdf_path)
        self.assertEqual(h1, h2)

    def test_index_pdf_and_find_duplicate(self):
        pdf_path = self._create_sample_pdf("doc_obstetrique.pdf", title_meta="Cours Obstétrique", text="Hémorragie de la délivrance")

        with patch("backend.database.DB_PATH", self.db_path), \
             patch("backend.indexer.DOCUMENTS_DIR", self.docs_dir), \
             patch("backend.indexer.CACHE_DIR", self.cache_dir), \
             patch("backend.indexer.COVERS_DIR", self.covers_dir):

            res = index_pdf_file(pdf_path, "doc_obstetrique.pdf")
            doc_id = res["id"]
            self.assertEqual(res["title"], "Cours Obstétrique")
            self.assertEqual(res["total_pages"], 1)

            # Vérifier la détection de doublon
            file_hash = compute_file_hash(pdf_path)
            dup = find_duplicate_by_hash(file_hash)
            self.assertIsNotNone(dup)
            self.assertEqual(dup["id"], doc_id)

            # Vérifier que la couverture a bien été générée
            cover_jpg = os.path.join(self.covers_dir, f"{doc_id}.jpg")
            self.assertTrue(os.path.exists(cover_jpg))

            # Ré-indexer le même fichier avec un titre personnalisé
            res_update = index_pdf_file(pdf_path, "doc_obstetrique.pdf", custom_title="Titre Modifié")
            self.assertEqual(res_update["id"], doc_id)
            self.assertEqual(res_update["title"], "Titre Modifié")

    def test_clean_base_title_heuristics(self):
        # Tester le nettoyage des titres par défaut (Word, untitled, underscores)
        pdf_path = self._create_sample_pdf("012__cours___gynecologie_-_partie_1.pdf", title_meta="Microsoft Word - Document1")

        with patch("backend.database.DB_PATH", self.db_path), \
             patch("backend.indexer.DOCUMENTS_DIR", self.docs_dir), \
             patch("backend.indexer.CACHE_DIR", self.cache_dir), \
             patch("backend.indexer.COVERS_DIR", self.covers_dir):

            res = index_pdf_file(pdf_path, "012__cours___gynecologie_-_partie_1.pdf")
            # Le titre Microsoft Word doit être ignoré au profit du nom nettoyé
            self.assertEqual(res["title"], "012 cours gynecologie - partie 1")

    def test_remove_document(self):
        pdf_path = self._create_sample_pdf("to_remove.pdf")

        with patch("backend.database.DB_PATH", self.db_path), \
             patch("backend.indexer.DOCUMENTS_DIR", self.docs_dir), \
             patch("backend.indexer.CACHE_DIR", self.cache_dir), \
             patch("backend.indexer.COVERS_DIR", self.covers_dir):

            res = index_pdf_file(pdf_path, "to_remove.pdf")
            doc_id = res["id"]

            # Créer un dossier de cache factice pour vérifier sa suppression
            fake_cache_dir = os.path.join(self.cache_dir, f"doc_{doc_id}")
            os.makedirs(fake_cache_dir, exist_ok=True)
            with open(os.path.join(fake_cache_dir, "crop.webp"), "w") as f:
                f.write("crop")

            # Suppression du document
            deleted = remove_document(doc_id)
            self.assertTrue(deleted)
            self.assertFalse(os.path.exists(pdf_path))
            self.assertFalse(os.path.exists(fake_cache_dir))

            # Tentative de suppression d'un ID inexistant
            deleted_again = remove_document(99999)
            self.assertFalse(deleted_again)

    def test_reindex_document(self):
        pdf_path = self._create_sample_pdf("to_reindex.pdf", text="Premier état du texte.")

        with patch("backend.database.DB_PATH", self.db_path), \
             patch("backend.indexer.DOCUMENTS_DIR", self.docs_dir), \
             patch("backend.indexer.CACHE_DIR", self.cache_dir), \
             patch("backend.indexer.COVERS_DIR", self.covers_dir):

            res = index_pdf_file(pdf_path, "to_reindex.pdf")
            doc_id = res["id"]

            # Assigner un dossier
            conn = get_db_connection()
            conn.execute("INSERT INTO folders (name) VALUES ('Mon Dossier');")
            folder_id = conn.execute("SELECT id FROM folders WHERE name = 'Mon Dossier';").fetchone()["id"]
            conn.execute("UPDATE documents SET folder_id = ? WHERE id = ?", (folder_id, doc_id))
            conn.commit()
            conn.close()

            # Modifier le PDF
            doc = pymupdf.open()
            page = doc.new_page()
            page.insert_text((50, 100), "Deuxième état avec nouveau mot-clé.")
            doc.save(pdf_path)
            doc.close()

            # Ré-indexer
            reindexed = reindex_document(doc_id)
            self.assertIsNotNone(reindexed)
            self.assertEqual(reindexed["id"], doc_id)
            self.assertEqual(reindexed["folder_id"], folder_id)

            # Cas d'erreur : doc_id inexistant
            self.assertIsNone(reindex_document(88888))

            # Cas d'erreur : fichier physique manquant
            os.remove(pdf_path)
            self.assertIsNone(reindex_document(doc_id))

    def test_scan_and_sync_documents(self):
        with patch("backend.database.DB_PATH", self.db_path), \
             patch("backend.indexer.DOCUMENTS_DIR", self.docs_dir), \
             patch("backend.indexer.CACHE_DIR", self.cache_dir), \
             patch("backend.indexer.COVERS_DIR", self.covers_dir):

            # 1. Répertoire vide
            sync1 = scan_and_sync_documents()
            self.assertEqual(sync1["added"], 0)

            # 2. Ajout de fichiers (un valide PDF, un non-PDF, un doublon)
            self._create_sample_pdf("nouveau_cours.pdf", title_meta="Cours Nouveau")
            with open(os.path.join(self.docs_dir, "notes.txt"), "w") as f:
                f.write("Ce fichier texte doit être ignoré.")

            sync2 = scan_and_sync_documents()
            self.assertEqual(sync2["added"], 1)
            self.assertIn("Cours Nouveau", sync2["indexed_files"])

            # 3. Deuxième synchronisation : le fichier existe déjà, rien à ajouter
            sync3 = scan_and_sync_documents()
            self.assertEqual(sync3["added"], 0)

if __name__ == "__main__":
    unittest.main()
