import os
import re
import shutil
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Header, Query
from fastapi.responses import FileResponse, StreamingResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from backend.database import init_db, get_db_connection
from backend.indexer import index_pdf_file, remove_document, DOCUMENTS_DIR, COVERS_DIR, CACHE_DIR
from backend.search_engine import search_documents

from pydantic import BaseModel

from contextlib import asynccontextmanager

# Initialiser la base de données SQLite
init_db()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Au démarrage, scanne et indexe automatiquement les nouveaux PDF déposés dans data/documents/."""
    try:
        from backend.indexer import scan_and_sync_documents
        res = scan_and_sync_documents()
        if res["added"] > 0:
            print(f"[DocFastExplorer] {res['added']} nouveau(x) document(s) synchronisé(s) au démarrage.")
    except Exception as e:
        print(f"[DocFastExplorer] Erreur lors de la synchronisation au démarrage : {e}")
    yield

app = FastAPI(title="DocFastExplorer API", lifespan=lifespan)

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")

class FolderCreate(BaseModel):
    name: str
    parent_id: Optional[int] = None
    color: Optional[str] = "#3b82f6"

class FolderUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None

class DocumentMove(BaseModel):
    folder_id: Optional[int] = None

class DocumentUpdate(BaseModel):
    title: Optional[str] = None

class AnnotationsPayload(BaseModel):
    annotations: List[Dict[str, Any]]

@app.get("/api/folders")
def list_folders(parent_id: Optional[str] = Query(None)):
    """Renvoie la liste des dossiers avec comptage des documents."""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    if parent_id == "root":
        cursor.execute("""
            SELECT f.id, f.name, f.parent_id, f.color, f.created_at,
                   COUNT(d.id) as doc_count
            FROM folders f
            LEFT JOIN documents d ON d.folder_id = f.id
            WHERE f.parent_id IS NULL
            GROUP BY f.id
            ORDER BY f.name ASC
        """)
    elif parent_id is not None and parent_id.isdigit():
        cursor.execute("""
            SELECT f.id, f.name, f.parent_id, f.color, f.created_at,
                   COUNT(d.id) as doc_count
            FROM folders f
            LEFT JOIN documents d ON d.folder_id = f.id
            WHERE f.parent_id = ?
            GROUP BY f.id
            ORDER BY f.name ASC
        """, (int(parent_id),))
    else:
        cursor.execute("""
            SELECT f.id, f.name, f.parent_id, f.color, f.created_at,
                   COUNT(d.id) as doc_count
            FROM folders f
            LEFT JOIN documents d ON d.folder_id = f.id
            GROUP BY f.id
            ORDER BY f.name ASC
        """)

    folders = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return {"folders": folders}

@app.post("/api/folders")
def create_folder(payload: FolderCreate):
    """Crée un nouveau dossier."""
    clean_name = payload.name.strip()
    if not clean_name:
        raise HTTPException(status_code=400, detail="Le nom du dossier ne peut pas être vide.")

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO folders (name, parent_id, color)
        VALUES (?, ?, ?)
    """, (clean_name, payload.parent_id, payload.color or "#3b82f6"))
    folder_id = cursor.lastrowid
    conn.commit()
    conn.close()

    return {
        "status": "success",
        "folder": {
            "id": folder_id,
            "name": clean_name,
            "parent_id": payload.parent_id,
            "color": payload.color or "#3b82f6",
            "doc_count": 0
        }
    }

@app.patch("/api/folders/{folder_id}")
def update_folder(folder_id: int, payload: FolderUpdate):
    """Modifie le nom ou la couleur d'un dossier."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM folders WHERE id = ?", (folder_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Dossier introuvable.")

    updates = []
    params = []
    if payload.name is not None and payload.name.strip():
        updates.append("name = ?")
        params.append(payload.name.strip())
    if payload.color is not None:
        updates.append("color = ?")
        params.append(payload.color)

    if updates:
        params.append(folder_id)
        cursor.execute(f"UPDATE folders SET {', '.join(updates)} WHERE id = ?", params)
        conn.commit()

    conn.close()
    return {"status": "success"}

@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: int):
    """Supprime un dossier et replace ses documents à la racine."""
    conn = get_db_connection()
    cursor = conn.cursor()
    # Replacer les documents dans la racine
    cursor.execute("UPDATE documents SET folder_id = NULL WHERE folder_id = ?", (folder_id,))
    cursor.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
    conn.commit()
    conn.close()
    return {"status": "success", "message": "Dossier supprimé."}

@app.patch("/api/documents/{doc_id}/move")
def move_document(doc_id: int, payload: DocumentMove):
    """Déplace un document vers un dossier spécifié (ou à la racine si folder_id=None)."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM documents WHERE id = ?", (doc_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Document introuvable.")

    if payload.folder_id is not None:
        cursor.execute("SELECT id FROM folders WHERE id = ?", (payload.folder_id,))
        if not cursor.fetchone():
            conn.close()
            raise HTTPException(status_code=400, detail="Dossier cible introuvable.")

    cursor.execute("UPDATE documents SET folder_id = ? WHERE id = ?", (payload.folder_id, doc_id))
    conn.commit()
    conn.close()

    return {"status": "success", "doc_id": doc_id, "folder_id": payload.folder_id}

class BatchDocumentMove(BaseModel):
    doc_ids: List[int]
    folder_id: Optional[int] = None

@app.post("/api/documents/batch-move")
def batch_move_documents(payload: BatchDocumentMove):
    """Déplace plusieurs documents vers un dossier spécifié (ou à la racine si folder_id=None)."""
    if not payload.doc_ids:
        return {"status": "success", "moved_count": 0}

    conn = get_db_connection()
    cursor = conn.cursor()

    if payload.folder_id is not None:
        cursor.execute("SELECT id FROM folders WHERE id = ?", (payload.folder_id,))
        if not cursor.fetchone():
            conn.close()
            raise HTTPException(status_code=400, detail="Dossier cible introuvable.")

    placeholders = ",".join(["?"] * len(payload.doc_ids))
    cursor.execute(
        f"UPDATE documents SET folder_id = ? WHERE id IN ({placeholders})",
        [payload.folder_id] + payload.doc_ids
    )
    conn.commit()
    conn.close()

    return {"status": "success", "moved_count": len(payload.doc_ids), "folder_id": payload.folder_id}

@app.patch("/api/documents/{doc_id}")
def rename_document(doc_id: int, payload: DocumentUpdate):
    """Renomme un document."""
    if not payload.title or not payload.title.strip():
        raise HTTPException(status_code=400, detail="Le titre ne peut pas être vide.")

    import unicodedata
    new_title = unicodedata.normalize("NFC", payload.title.strip())
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE documents SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (new_title, doc_id))
    if cursor.rowcount == 0:
        conn.close()
        raise HTTPException(status_code=404, detail="Document introuvable.")
    conn.commit()
    conn.close()
    return {"id": doc_id, "title": new_title, "message": "Document renommé avec succès."}

def _apply_annotations_to_pdf(pdf_path: str, annotations: List[Dict[str, Any]]):
    """
    Applique les annotations directement sur le fichier PDF local via PyMuPDF.
    Sauvegarde incrémentale instantanée sans ré-upload de PDF.
    """
    import pymupdf
    try:
        doc = pymupdf.open(pdf_path)
        modified = False

        for a in annotations:
            page_index = a.get("pageIndex")
            if page_index is None or page_index < 0 or page_index >= len(doc):
                continue
            page = doc[page_index]
            annot_type = a.get("annotationType") or a.get("annotationEditorType")

            # 9: Highlight (Surlignage)
            if annot_type == 9:
                rect = a.get("rect")
                if rect and len(rect) == 4:
                    annot = page.add_highlight_annot(pymupdf.Rect(rect[0], rect[1], rect[2], rect[3]))
                    color = a.get("color")
                    if color and len(color) == 3:
                        annot.set_colors(stroke=(color[0]/255.0 if color[0] > 1 else color[0],
                                                 color[1]/255.0 if color[1] > 1 else color[1],
                                                 color[2]/255.0 if color[2] > 1 else color[2]))
                    annot.update()
                    modified = True

            # 3: FreeText (Texte libre)
            elif annot_type == 3:
                rect = a.get("rect")
                val = a.get("value")
                if rect and len(rect) == 4 and val:
                    annot = page.add_freetext_annot(
                        pymupdf.Rect(rect[0], rect[1], rect[2], rect[3]),
                        str(val),
                        fontsize=a.get("fontSize", 12)
                    )
                    annot.update()
                    modified = True

            # 15: Ink (Tracé libre au stylet)
            elif annot_type == 15:
                paths = a.get("paths") or a.get("lines")
                if paths:
                    try:
                        annot = page.add_ink_annot(paths)
                        annot.update()
                        modified = True
                    except Exception:
                        pass

        if modified:
            try:
                doc.save(pdf_path, incremental=True, encryption=pymupdf.PDF_ENCRYPT_KEEP)
            except Exception:
                tmp_path = pdf_path + ".tmp"
                doc.save(tmp_path)
                doc.close()
                os.replace(tmp_path, pdf_path)
                return
        doc.close()
    except Exception as e:
        print(f"[PDF Annotations] Erreur PyMuPDF: {e}")

@app.post("/api/documents/{doc_id}/annotations")
def save_annotations(doc_id: int, payload: AnnotationsPayload):
    """
    Sauvegarde légère des annotations (surlignages, dessins, notes textuelles)
    sans retélécharger l'intégralité du PDF.
    """
    import json
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, filename FROM documents WHERE id = ?", (doc_id,))
    doc = cursor.fetchone()
    if not doc:
        conn.close()
        raise HTTPException(status_code=404, detail="Document introuvable.")

    raw_json = json.dumps(payload.annotations)
    cursor.execute("""
        INSERT INTO document_annotations (doc_id, annotations_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(doc_id) DO UPDATE SET
            annotations_json = excluded.annotations_json,
            updated_at = CURRENT_TIMESTAMP;
    """, (doc_id, raw_json))
    cursor.execute("UPDATE documents SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (doc_id,))
    conn.commit()
    conn.close()

    # Appliquer directement dans le fichier PDF local sur le serveur
    try:
        from backend.indexer import DOCUMENTS_DIR
        pdf_path = os.path.join(DOCUMENTS_DIR, doc["filename"])
        if os.path.exists(pdf_path) and payload.annotations:
            _apply_annotations_to_pdf(pdf_path, payload.annotations)
    except Exception as e:
        print(f"[Annotations] Erreur lors de l'application sur le PDF : {e}")

    return {"status": "success", "count": len(payload.annotations)}

@app.get("/api/documents/{doc_id}/annotations")
def get_annotations(doc_id: int):
    """Renvoie les annotations enregistrées pour ce document."""
    import json
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT annotations_json, updated_at FROM document_annotations WHERE doc_id = ?", (doc_id,))
    row = cursor.fetchone()
    conn.close()
    if not row:
        return {"annotations": [], "updated_at": None}
    try:
        annots = json.loads(row["annotations_json"])
    except Exception:
        annots = []
    return {"annotations": annots, "updated_at": row["updated_at"]}

@app.post("/api/documents/{doc_id}/reindex")
def reindex_single_document(doc_id: int):
    """Réindexe manuellement un document spécifique."""
    from backend.indexer import reindex_document
    result = reindex_document(doc_id)
    if not result:
        raise HTTPException(status_code=404, detail="Document non trouvé ou fichier source manquant.")
    result["cover_url"] = f"/api/cover/{doc_id}"
    result["pdf_url"] = f"/api/pdf/{doc_id}"
    return {"status": "success", "document": result}

@app.post("/api/sync")
def sync_documents():
    """Scanne le répertoire data/documents/ et indexe tous les nouveaux fichiers PDF."""
    from backend.indexer import scan_and_sync_documents
    result = scan_and_sync_documents()
    return {"status": "success", **result}

@app.get("/api/documents")
def list_documents(folder_id: Optional[str] = Query(None)):
    """Renvoie la liste des documents, éventuellement filtrée par dossier."""
    conn = get_db_connection()
    cursor = conn.cursor()

    if folder_id == "root":
        cursor.execute("""
            SELECT id, filename, title, folder_id, total_pages, file_size, created_at, COALESCE(updated_at, created_at) AS updated_at 
            FROM documents 
            WHERE folder_id IS NULL
            ORDER BY id DESC
        """)
    elif folder_id is not None and folder_id.isdigit():
        cursor.execute("""
            SELECT id, filename, title, folder_id, total_pages, file_size, created_at, COALESCE(updated_at, created_at) AS updated_at 
            FROM documents 
            WHERE folder_id = ?
            ORDER BY id DESC
        """, (int(folder_id),))
    else:
        cursor.execute("""
            SELECT id, filename, title, folder_id, total_pages, file_size, created_at, COALESCE(updated_at, created_at) AS updated_at 
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
async def upload_pdf(file: UploadFile = File(...), title: Optional[str] = Form(None), folder_id: Optional[int] = Form(None)):
    """Reçoit un fichier PDF, vérifie s'il est en doublon strict, et l'indexe."""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Seuls les fichiers PDF sont acceptés.")

    original_filename = file.filename
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
        base, ext = os.path.splitext(safe_filename)
        safe_filename = f"{base}_{file_hash[:6]}{ext}"
        dest_path = os.path.join(DOCUMENTS_DIR, safe_filename)

    shutil.move(temp_path, dest_path)

    try:
        doc_info = index_pdf_file(dest_path, safe_filename, custom_title=title)
        
        # Assigner au dossier si précisé
        if folder_id is not None:
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute("UPDATE documents SET folder_id = ? WHERE id = ?", (folder_id, doc_info["id"]))
            conn.commit()
            conn.close()
            doc_info["folder_id"] = folder_id

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
def search(
    q: str = Query(..., min_length=1),
    titles_only: bool = Query(False),
    folder_id: Optional[int] = Query(None)
):
    """Recherche de mots-clés dans les documents avec filtres (titres seuls, dossier courant)."""
    return search_documents(q, titles_only=titles_only, folder_id=folder_id)

@app.get("/api/cover/{doc_id}")
def get_cover(doc_id: int):
    """Renvoie la miniature de la première page du document avec cache immuable longue durée."""
    cover_webp = os.path.join(COVERS_DIR, f"{doc_id}.webp")
    cover_jpg = os.path.join(COVERS_DIR, f"{doc_id}.jpg")
    cache_headers = {"Cache-Control": "public, max-age=31536000, immutable"}
    if os.path.exists(cover_webp):
        return FileResponse(cover_webp, media_type="image/webp", headers=cache_headers)
    if os.path.exists(cover_jpg):
        return FileResponse(cover_jpg, media_type="image/jpeg", headers=cache_headers)
    raise HTTPException(status_code=404, detail="Couverture non disponible.")

@app.get("/api/crop/{doc_id}/{page}/{occ_id}")
def get_crop(doc_id: int, page: int, occ_id: int, h: Optional[str] = Query(None), terms: Optional[str] = Query(None)):
    """Renvoie la vignette cropée, générée à la volée (Lazy Crop) si nécessaire."""
    from backend.crop_service import get_or_generate_crop_on_demand
    
    terms_decoded = terms or ""
    crop_path = get_or_generate_crop_on_demand(doc_id, page, occ_id, h or "", terms_decoded)
    
    # Cache court/aucun pour les requêtes de recherche très spécifiques (selon demande utilisateur)
    nocache_headers = {"Cache-Control": "no-cache, must-revalidate"}
    
    if crop_path and os.path.exists(crop_path):
        media_type = "image/webp" if crop_path.endswith(".webp") else "image/jpeg"
        return FileResponse(crop_path, media_type=media_type, headers=nocache_headers)

    doc_cache_dir = os.path.join(CACHE_DIR, f"doc_{doc_id}")
    if os.path.exists(doc_cache_dir):
        for fname in os.listdir(doc_cache_dir):
            if fname.startswith(f"p{page}_occ{occ_id}"):
                fpath = os.path.join(doc_cache_dir, fname)
                media_type = "image/webp" if fname.endswith(".webp") else "image/jpeg"
                return FileResponse(fpath, media_type=media_type, headers=nocache_headers)

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

class NoCacheStaticFiles(StaticFiles):
    def file_response(self, *args, **kwargs) -> Response:
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp

# Monter les fichiers statiques du frontend avec cache désactivé pour CSS et JS
if os.path.exists(FRONTEND_DIR):
    app.mount("/", NoCacheStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
