import unittest
from fastapi.testclient import TestClient
from backend.main import app
from backend.database import get_db_connection

class TestFoldersAndFilters(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_folder_crud_and_move(self):
        # 1. Création d'un dossier
        resp = self.client.post("/api/folders", json={"name": "Test Goodnotes Folder", "color": "#ef4444"})
        self.assertEqual(resp.status_code, 200)
        folder = resp.json()["folder"]
        folder_id = folder["id"]
        self.assertEqual(folder["name"], "Test Goodnotes Folder")
        self.assertEqual(folder["color"], "#ef4444")

        # 2. Liste des dossiers
        resp = self.client.get("/api/folders")
        self.assertEqual(resp.status_code, 200)
        folders = resp.json()["folders"]
        matching = [f for f in folders if f["id"] == folder_id]
        self.assertEqual(len(matching), 1)

        # 3. Modification du dossier (nom + couleur)
        resp = self.client.patch(f"/api/folders/{folder_id}", json={"name": "Renamed Folder", "color": "#3b82f6"})
        self.assertEqual(resp.status_code, 200)

        # 4. Récupérer un document existant
        resp = self.client.get("/api/documents")
        docs = resp.json()["documents"]
        self.assertGreater(len(docs), 0)
        test_doc_id = docs[0]["id"]

        # 5. Déplacer le document dans le dossier
        resp = self.client.patch(f"/api/documents/{test_doc_id}/move", json={"folder_id": folder_id})
        self.assertEqual(resp.status_code, 200)

        # Vérifier que le document est bien dans le dossier
        resp = self.client.get(f"/api/documents?folder_id={folder_id}")
        doc_ids = [d["id"] for d in resp.json()["documents"]]
        self.assertIn(test_doc_id, doc_ids)

        # 6. Remettre le document à la racine
        resp = self.client.patch(f"/api/documents/{test_doc_id}/move", json={"folder_id": None})
        self.assertEqual(resp.status_code, 200)

        # 7. Supprimer le dossier
        resp = self.client.delete(f"/api/folders/{folder_id}")
        self.assertEqual(resp.status_code, 200)

    def test_search_titles_only(self):
        # Recherche avec titles_only=true
        resp = self.client.get("/api/search?q=grossesse&titles_only=true")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("results", data)
        # Chaque résultat doit avoir total_occurrences = 0 (pas d'extraction de page) et le titre doit correspondre
        for doc in data["results"]:
            self.assertEqual(doc["total_occurrences"], 0)
            self.assertIn("grossesse", (doc["title"] + doc["filename"]).lower())

    def test_search_folder_filter(self):
        # Créer un dossier temporaire
        resp = self.client.post("/api/folders", json={"name": "Dossier Filtre", "color": "#10b981"})
        folder_id = resp.json()["folder"]["id"]

        try:
            # Récupérer un document
            resp = self.client.get("/api/documents")
            docs = resp.json()["documents"]
            doc_id = docs[0]["id"]

            # Le classer dans ce dossier
            self.client.patch(f"/api/documents/{doc_id}/move", json={"folder_id": folder_id})

            # Recherche avec folder_id
            resp = self.client.get(f"/api/search?q=grossesse&folder_id={folder_id}")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            for doc in data["results"]:
                self.assertEqual(doc["folder_id"], folder_id)

            # Replacer à la racine
            self.client.patch(f"/api/documents/{doc_id}/move", json={"folder_id": None})
        finally:
            self.client.delete(f"/api/folders/{folder_id}")

    def test_sync_endpoint(self):
        resp = self.client.post("/api/sync")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data.get("status"), "success")
        self.assertIn("added", data)

    def test_reindex_endpoint(self):
        resp = self.client.get("/api/documents")
        docs = resp.json()["documents"]
        self.assertGreater(len(docs), 0)
        first_doc_id = docs[0]["id"]

        resp = self.client.post(f"/api/documents/{first_doc_id}/reindex")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data.get("status"), "success")
        self.assertIn("document", data)

if __name__ == "__main__":
    unittest.main()
