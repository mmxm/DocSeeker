import unittest
import os
import tempfile
import sqlite3
from unittest.mock import patch

from backend.database import normalize_text, get_db_connection, init_db, DB_PATH

class TestUnitDatabase(unittest.TestCase):
    def test_normalize_text_edge_cases(self):
        # Cas nominaux
        self.assertEqual(normalize_text("Hémorragie"), "hemorragie")
        self.assertEqual(normalize_text("DÉLIVRANCE"), "delivrance")
        self.assertEqual(normalize_text("Grossesse extra-utérine"), "grossesse extra-uterine")
        self.assertEqual(normalize_text("À l'hôpital"), "a l'hopital")

        # Cas limites et spéciaux
        self.assertEqual(normalize_text(""), "")
        self.assertEqual(normalize_text(None), "")
        self.assertEqual(normalize_text("   "), "   ")
        self.assertEqual(normalize_text("12345"), "12345")
        self.assertEqual(normalize_text("Éléphant à Noël çà et là"), "elephant a noel ca et la")
        self.assertEqual(normalize_text("TEST_SANS_ACCENTS"), "test_sans_accents")
        self.assertEqual(normalize_text("ùûüÿñ"), "uuuyn")

    def test_get_db_connection_pragmas(self):
        conn = get_db_connection()
        try:
            self.assertIsInstance(conn, sqlite3.Connection)
            self.assertEqual(conn.row_factory, sqlite3.Row)

            # Vérifier l'activation des clés étrangères
            cursor = conn.cursor()
            cursor.execute("PRAGMA foreign_keys;")
            self.assertEqual(cursor.fetchone()[0], 1)

            # Vérifier le mode journal WAL
            cursor.execute("PRAGMA journal_mode;")
            self.assertEqual(cursor.fetchone()[0].lower(), "wal")

            # Vérifier le mode synchronous
            cursor.execute("PRAGMA synchronous;")
            # 1 = NORMAL
            self.assertEqual(cursor.fetchone()[0], 1)

            # Vérifier la taille du cache
            cursor.execute("PRAGMA cache_size;")
            self.assertEqual(cursor.fetchone()[0], -64000)
        finally:
            conn.close()

    def test_init_db_in_isolated_temp_database(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_db_path = os.path.join(tmpdir, "test_db.sqlite")
            with patch("backend.database.DB_PATH", temp_db_path):
                # Première initialisation
                init_db()
                self.assertTrue(os.path.exists(temp_db_path))

                # Deuxième initialisation pour vérifier l'idempotence
                init_db()

                conn = get_db_connection()
                cursor = conn.cursor()

                # Vérifier la présence de toutes les tables attendues
                cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
                tables = {row["name"] for row in cursor.fetchall()}
                expected_tables = {"folders", "documents", "pages", "pages_fts", "document_annotations"}
                self.assertTrue(expected_tables.issubset(tables))

                # Vérifier les colonnes de la table documents
                cursor.execute("PRAGMA table_info(documents);")
                doc_columns = {row["name"] for row in cursor.fetchall()}
                self.assertIn("file_hash", doc_columns)
                self.assertIn("folder_id", doc_columns)
                self.assertIn("updated_at", doc_columns)
                self.assertIn("created_at", doc_columns)

                # Tester le comportement CASCADE et SET NULL
                cursor.execute("INSERT INTO folders (name, color) VALUES ('Dossier Test', '#123456');")
                folder_id = cursor.lastrowid

                cursor.execute("""
                    INSERT INTO documents (filename, title, file_hash, folder_id, total_pages, file_size)
                    VALUES ('doc1.pdf', 'Document 1', 'hash123', ?, 10, 1024);
                """, (folder_id,))
                doc_id = cursor.lastrowid

                cursor.execute("""
                    INSERT INTO pages (doc_id, page_number, text_content, words_json)
                    VALUES (?, 1, 'Texte page 1', '[]');
                """, (doc_id,))

                cursor.execute("""
                    INSERT INTO document_annotations (doc_id, annotations_json)
                    VALUES (?, '[]');
                """, (doc_id,))
                conn.commit()

                # Vérifier que supprimer le dossier met le folder_id du document à NULL (SET NULL)
                cursor.execute("DELETE FROM folders WHERE id = ?;", (folder_id,))
                conn.commit()
                cursor.execute("SELECT folder_id FROM documents WHERE id = ?;", (doc_id,))
                self.assertIsNone(cursor.fetchone()["folder_id"])

                # Vérifier que supprimer le document supprime en CASCADE ses pages et annotations
                cursor.execute("DELETE FROM documents WHERE id = ?;", (doc_id,))
                conn.commit()
                cursor.execute("SELECT COUNT(*) as cnt FROM pages WHERE doc_id = ?;", (doc_id,))
                self.assertEqual(cursor.fetchone()["cnt"], 0)
                cursor.execute("SELECT COUNT(*) as cnt FROM document_annotations WHERE doc_id = ?;", (doc_id,))
                self.assertEqual(cursor.fetchone()["cnt"], 0)

                conn.close()

    def test_migration_when_columns_missing(self):
        """Simule une ancienne base où file_hash, folder_id et updated_at n'existaient pas."""
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_db_path = os.path.join(tmpdir, "old_schema.sqlite")
            # Créer l'ancien schéma manuellement
            conn = sqlite3.connect(temp_db_path)
            conn.execute("""
                CREATE TABLE documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    filename TEXT NOT NULL UNIQUE,
                    title TEXT,
                    total_pages INTEGER DEFAULT 0,
                    file_size INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            """)
            conn.execute("INSERT INTO documents (filename, title) VALUES ('old.pdf', 'Old Doc');")
            conn.commit()
            conn.close()

            with patch("backend.database.DB_PATH", temp_db_path):
                init_db()
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute("PRAGMA table_info(documents);")
                cols = {r["name"] for r in cursor.fetchall()}
                self.assertIn("file_hash", cols)
                self.assertIn("folder_id", cols)
                self.assertIn("updated_at", cols)
                
                # Vérifier que updated_at a été initialisé avec created_at
                cursor.execute("SELECT updated_at, created_at FROM documents WHERE filename = 'old.pdf';")
                row = cursor.fetchone()
                self.assertIsNotNone(row["updated_at"])
                self.assertEqual(row["updated_at"], row["created_at"])
                conn.close()

if __name__ == "__main__":
    unittest.main()
