import os
import re
import shutil
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Header, Query
from fastapi.responses import FileResponse, StreamingResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from backend.database import init_db, get_db_connection
from backend.indexer import index_pdf_file, remove_document, DOCUMENTS_DIR, COVERS_DIR, CACHE_DIR
from backend.search_engine import search_documents

# Initialiser la base de données SQLite
init_db()

app = FastAPI(title="DocFastExplorer API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")

@app.get("/api/documents")
def list_documents():
    """Renvoie la liste de tous les documents enregistrés."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, filename, title, total_pages, file_size, created_at 
        FROM documents 
        ORDER BY id DESC
    """)
    docs = [dict(r) for r in cursor.fetchall()]
    conn.close()

    for doc in docs:
        doc["cover_url"] = f"/api/cover/{doc['id']}"
        doc["pdf_url"] = f"/api/pdf/{doc['id']}"

    return {"documents": docs, "total": len(docs)}

@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...), title: Optional[str] = Form(None)):
    """Reçoit un fichier PDF, vérifie s'il est en doublon strict, et l'indexe."""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Seuls les fichiers PDF sont acceptés.")

    original_filename = file.filename
    # Nettoyage sécurisé minimal pour le système de fichier sans défigurer les espaces et accents
    # On supprime seulement les séparateurs de chemin potentiellement dangereux
    safe_filename = re.sub(r'[/\\:\0]', ' ', original_filename).strip()
    dest_path = os.path.join(DOCUMENTS_DIR, safe_filename)

    # Sauvegarde temporaire pour vérification du hash SHA-256
    temp_path = dest_path + ".tmp"
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    from backend.indexer import compute_file_hash, find_duplicate_by_hash
    file_hash = compute_file_hash(temp_path)

    # Vérification de doublon strict
    duplicate = find_duplicate_by_hash(file_hash)
    if duplicate:
        os.remove(temp_path)
        return JSONResponse(
            status_code=409,
            content={
                "error": "duplicate",
                "message": "Un document strictement identique existe déjà dans la base.",
                "existing_doc": {
                    "id": duplicate["id"],
                    "filename": duplicate["filename"],
                    "title": duplicate["title"],
                    "created_at": duplicate["created_at"]
                }
            }
        )

    # Déplacement définitif
    if os.path.exists(dest_path):
        # Si un fichier de même nom existe mais contenu différent, suffixer
        base, ext = os.path.splitext(safe_filename)
        safe_filename = f"{base}_{file_hash[:6]}{ext}"
        dest_path = os.path.join(DOCUMENTS_DIR, safe_filename)

    shutil.move(temp_path, dest_path)

    try:
        doc_info = index_pdf_file(dest_path, safe_filename, custom_title=title)
        doc_info["cover_url"] = f"/api/cover/{doc_info['id']}"
        doc_info["pdf_url"] = f"/api/pdf/{doc_info['id']}"
        return {"status": "success", "document": doc_info}
    except Exception as e:
        if os.path.exists(dest_path):
            os.remove(dest_path)
        raise HTTPException(status_code=500, detail=f"Erreur lors de l'indexation : {str(e)}")

@app.delete("/api/documents/{doc_id}")
def delete_pdf(doc_id: int):
    """Supprime un PDF, ses index, ses pages et ses caches."""
    success = remove_document(doc_id)
    if not success:
        raise HTTPException(status_code=404, detail="Document non trouvé.")
    return {"status": "success", "message": "Document supprimé avec succès."}

@app.get("/api/search")
def search(q: str = Query(..., min_length=1)):
    """Recherche de mots-clés dans l'ensemble des documents avec classement par pertinence."""
    return search_documents(q)

@app.get("/api/cover/{doc_id}")
def get_cover(doc_id: int):
    """Renvoie la miniature de la première page du document."""
    cover_path = os.path.join(COVERS_DIR, f"{doc_id}.jpg")
    if not os.path.exists(cover_path):
        raise HTTPException(status_code=404, detail="Couverture non disponible.")
    return FileResponse(cover_path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=3600"})

@app.get("/api/crop/{doc_id}/{page}/{occ_id}")
def get_crop(doc_id: int, page: int, occ_id: int, h: Optional[str] = Query(None), terms: Optional[str] = Query(None)):
    """Renvoie la vignette cropée, générée à la volée (Lazy Crop) si nécessaire."""
    from backend.crop_service import get_or_generate_crop_on_demand
    
    terms_decoded = terms or ""
    crop_path = get_or_generate_crop_on_demand(doc_id, page, occ_id, h or "", terms_decoded)
    
    if crop_path and os.path.exists(crop_path):
        return FileResponse(crop_path, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})

    doc_cache_dir = os.path.join(CACHE_DIR, f"doc_{doc_id}")
    if os.path.exists(doc_cache_dir):
        for fname in os.listdir(doc_cache_dir):
            if fname.startswith(f"p{page}_occ{occ_id}") and fname.endswith(".jpg"):
                return FileResponse(os.path.join(doc_cache_dir, fname), media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})

    raise HTTPException(status_code=404, detail="Vignette non trouvée.")

@app.get("/api/doc-search")
def doc_search(doc_id: int = Query(...), q: str = Query(..., min_length=1)):
    """Recherche ciblée au sein d'un document spécifique."""
    from backend.search_engine import search_within_document
    return search_within_document(doc_id, q)

@app.get("/api/pdf/{doc_id}")
def stream_pdf(doc_id: int, range: Optional[str] = Header(None)):
    """
    Stream du document PDF avec support strict des requêtes HTTP Range (206 Partial Content).
    Permet à Mozilla PDF.js de ne charger que les fragments de pages consultés.
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT filename FROM documents WHERE id = ?", (doc_id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Document introuvable.")

    file_path = os.path.join(DOCUMENTS_DIR, row["filename"])
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Fichier PDF manquant sur le disque.")

    file_size = os.path.getsize(file_path)

    # Si aucun en-tête Range, réponse standard 200 OK avec Accept-Ranges
    if not range:
        return FileResponse(
            file_path, 
            media_type="application/pdf", 
            headers={"Accept-Ranges": "bytes"}
        )

    # Parsing du Range: bytes=start-end
    match = re.match(r"bytes=(\d+)-(\d*)", range.strip())
    if not match:
        return FileResponse(
            file_path, 
            media_type="application/pdf", 
            headers={"Accept-Ranges": "bytes"}
        )

    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else file_size - 1

    if start >= file_size:
        return Response(
            status_code=416, 
            headers={"Content-Range": f"bytes */{file_size}"}
        )

    end = min(end, file_size - 1)
    chunk_size = (end - start) + 1

    def iter_file_chunk():
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = chunk_size
            while remaining > 0:
                read_bytes = min(remaining, 64 * 1024)
                data = f.read(read_bytes)
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(chunk_size),
        "Content-Type": "application/pdf"
    }

    return StreamingResponse(iter_file_chunk(), status_code=206, headers=headers)

# Monter les fichiers statiques du frontend
if os.path.exists(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
