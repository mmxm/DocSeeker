import os
import json
import shutil
import pymupdf
from typing import Optional, Dict, Any
from backend.database import get_db_connection

DOCUMENTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "documents")
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "cache_crops")
COVERS_DIR = os.path.join(CACHE_DIR, "covers")

os.makedirs(DOCUMENTS_DIR, exist_ok=True)
os.makedirs(COVERS_DIR, exist_ok=True)

import hashlib

def compute_file_hash(file_path: str) -> str:
    """Calcule l'empreinte SHA-256 complète du fichier pour détection de doublons stricts."""
    hasher = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(64 * 1024):
            hasher.update(chunk)
    return hasher.hexdigest()

def find_duplicate_by_hash(file_hash: str) -> Optional[Dict[str, Any]]:
    """Vérifie si un document avec le même hash existe déjà en base."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, filename, title, created_at 
        FROM documents 
        WHERE file_hash = ?
    """, (file_hash,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def index_pdf_file(file_path: str, original_filename: str, custom_title: Optional[str] = None) -> Dict[str, Any]:
    """
    Indexe un fichier PDF :
    1. Calcule l'empreinte SHA-256.
    2. Extrait les métadonnées et le nombre de pages en préservant le titre lisible.
    3. Génère une miniature de couverture (première page).
    4. Extrait pour chaque page le texte et la liste géométrique des mots (bounding boxes).
    5. Insère dans SQLite et FTS5.
    """
    file_hash = compute_file_hash(file_path)
    doc = pymupdf.open(file_path)
    total_pages = len(doc)
    file_size = os.path.getsize(file_path)

    # Titre propre : priorité au titre personnalisé, sinon nom du fichier propre sans extension
    clean_base_title = os.path.splitext(original_filename)[0].replace("_", " ").strip()
    pdf_meta_title = doc.metadata.get("title", "").strip() if doc.metadata else ""
    # Éviter les titres de métadonnées PDF génériques ou corrompus
    if pdf_meta_title and len(pdf_meta_title) > 2 and not pdf_meta_title.lower().startswith("microsoft"):
        title = custom_title or pdf_meta_title
    else:
        title = custom_title or clean_base_title

    conn = get_db_connection()
    cursor = conn.cursor()

    # Vérifier si déjà présent par filename
    cursor.execute("SELECT id FROM documents WHERE filename = ?", (original_filename,))
    existing = cursor.fetchone()
    if existing:
        doc_id = existing["id"]
        cursor.execute("DELETE FROM pages WHERE doc_id = ?", (doc_id,))
        cursor.execute("DELETE FROM pages_fts WHERE doc_id = ?", (doc_id,))
        cursor.execute("""
            UPDATE documents 
            SET title = ?, file_hash = ?, total_pages = ?, file_size = ?, created_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        """, (title, file_hash, total_pages, file_size, doc_id))
    else:
        cursor.execute("""
            INSERT INTO documents (filename, title, file_hash, total_pages, file_size) 
            VALUES (?, ?, ?, ?, ?)
        """, (original_filename, title, file_hash, total_pages, file_size))
        doc_id = cursor.lastrowid

    # Générer la miniature de la couverture (page 1)
    if total_pages > 0:
        first_page = doc[0]
        # Largeur ~180px pour la vignette Goodnotes
        scale = 180 / first_page.rect.width if first_page.rect.width > 0 else 1.0
        matrix = pymupdf.Matrix(scale, scale)
        cover_pix = first_page.get_pixmap(matrix=matrix, alpha=False)
        cover_path = os.path.join(COVERS_DIR, f"{doc_id}.jpg")
        cover_pix.save(cover_path)

    # Parcourir les pages et indexer texte + coordonnées
    for page_idx in range(total_pages):
        page = doc[page_idx]
        page_num = page_idx + 1
        page_text = page.get_text("text")

        # get_text("words") renvoie : (x0, y0, x1, y1, word, block_no, line_no, word_no)
        raw_words = page.get_text("words")
        # On stocke une structure allégée : [round(x0,1), round(y0,1), round(x1,1), round(y1,1), word, block_no, line_no]
        words_data = [
            [round(w[0], 1), round(w[1], 1), round(w[2], 1), round(w[3], 1), w[4], w[5], w[6]]
            for w in raw_words
        ]

        cursor.execute("""
            INSERT INTO pages (doc_id, page_number, text_content, words_json)
            VALUES (?, ?, ?, ?)
        """, (doc_id, page_num, page_text, json.dumps(words_data, ensure_ascii=False)))

        cursor.execute("""
            INSERT INTO pages_fts (doc_id, page_number, text_content)
            VALUES (?, ?, ?)
        """, (doc_id, page_num, page_text))

    conn.commit()
    conn.close()
    doc.close()

    return {
        "id": doc_id,
        "filename": original_filename,
        "title": title,
        "total_pages": total_pages,
        "file_size": file_size
    }

def remove_document(doc_id: int) -> bool:
    """Supprime un document, son fichier PDF, ses pages, ses entrées FTS et son cache."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT filename FROM documents WHERE id = ?", (doc_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return False

    filename = row["filename"]
    cursor.execute("DELETE FROM pages WHERE doc_id = ?", (doc_id,))
    cursor.execute("DELETE FROM pages_fts WHERE doc_id = ?", (doc_id,))
    cursor.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    conn.commit()
    conn.close()

    # Supprimer le fichier PDF
    pdf_path = os.path.join(DOCUMENTS_DIR, filename)
    if os.path.exists(pdf_path):
        try:
            os.remove(pdf_path)
        except OSError:
            pass

    # Supprimer la couverture
    cover_path = os.path.join(COVERS_DIR, f"{doc_id}.jpg")
    if os.path.exists(cover_path):
        try:
            os.remove(cover_path)
        except OSError:
            pass

    # Nettoyer les crops en cache pour ce document
    doc_cache_dir = os.path.join(CACHE_DIR, f"doc_{doc_id}")
    if os.path.exists(doc_cache_dir):
        shutil.rmtree(doc_cache_dir, ignore_errors=True)

    return True
