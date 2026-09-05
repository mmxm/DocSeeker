import unittest
import os
import tempfile
import sqlite3
from backend.database import normalize_text, init_db, get_db_connection

class TestDatabase(unittest.TestCase):
    def test_normalize_text(self):
        self.assertEqual(normalize_text("Hémorragie"), "hemorragie")
        self.assertEqual(normalize_text("DÉLIVRANCE"), "delivrance")
        self.assertEqual(normalize_text("Grossesse extra-utérine"), "grossesse extra-uterine")
        self.assertEqual(normalize_text("À l'hôpital"), "a l'hopital")

    def test_database_initialization(self):
        conn = get_db_connection()
        cursor = conn.cursor()
        
        # Vérifier que les tables existent
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = [r["name"] for r in cursor.fetchall()]
        
        self.assertIn("documents", tables)
        self.assertIn("pages", tables)
        self.assertIn("pages_fts", tables)
        
        # Vérifier la colonne file_hash
        cursor.execute("PRAGMA table_info(documents);")
        columns = [r["name"] for r in cursor.fetchall()]
        self.assertIn("file_hash", columns)
        
        conn.close()

if __name__ == "__main__":
    unittest.main()
