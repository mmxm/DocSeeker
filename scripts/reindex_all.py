import os
import shutil
import glob
from backend.database import init_db, get_db_connection
from backend.indexer import index_pdf_file, DOCUMENTS_DIR, CACHE_DIR, COVERS_DIR

def reindex_all():
    print("=== Démarrage de la ré-indexation complète ===")

    # 1. Vider le cache des vignettes
    if os.path.exists(CACHE_DIR):
        print(f"Nettoyage du cache {CACHE_DIR}...")
        for item in os.listdir(CACHE_DIR):
            item_path = os.path.join(CACHE_DIR, item)
            if os.path.isdir(item_path) and item != "covers":
                shutil.rmtree(item_path, ignore_errors=True)

    # 2. Réinitialiser la base de données
    db_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "db.sqlite")
    if os.path.exists(db_path):
        os.remove(db_path)
    init_db()
    print("Base SQLite FTS5 réinitialisée.")

    # 3. Scanner tous les PDF dans data/documents
    pdf_files = sorted(glob.glob(os.path.join(DOCUMENTS_DIR, "*.pdf")))
    print(f"Nombre de PDF trouvés dans data/documents/ : {len(pdf_files)}")

    for idx, pdf_path in enumerate(pdf_files, 1):
        filename = os.path.basename(pdf_path)
        # Nettoyer les faux fichiers de test générés précédemment s'ils existent
        if filename in ["cours_gyneco.pdf", "024_principales_complications_grossesse.pdf", "025_grossesse_extra_uterine.pdf", "gynecologie_obstetrique_college.pdf"]:
            continue

        print(f"[{idx}/{len(pdf_files)}] Indexation de : {filename} ...")
        try:
            res = index_pdf_file(pdf_path, filename)
            print(f"    ✓ OK : '{res['title']}' ({res['total_pages']} pages)")
        except Exception as e:
            print(f"    ✗ Erreur : {e}")

    print("=== Ré-indexation terminée avec succès ! ===")

if __name__ == "__main__":
    reindex_all()
