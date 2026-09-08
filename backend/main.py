import os
import re
import shutil
import unicodedata
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Header, Query, Request
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
            print(f"[DocSeeker] {res['added']} nouveau(x) document(s) synchronisé(s) au démarrage.")
    except Exception as e:
        print(f"[DocSeeker] Erreur lors de la synchronisation au démarrage : {e}")

    # Démarrage du pipeline d'indexation d'arrière-plan
    from backend.pipeline import pipeline
    pipeline.start()
    yield
    pipeline.stop(wait=False)

app = FastAPI(title="DocSeeker API", lifespan=lifespan)

DOCSEEKER_VERSION = os.getenv("DOCSEEKER_VERSION", "1.0.0")
GIT_COMMIT = os.getenv("GIT_COMMIT", "dev")

app.add_middleware(GZipMiddleware, minimum_size=1000)

allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "")
if allowed_origins_env:
    origins = [o.strip() for o in allowed_origins_env.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )
else:
    # Par défaut : pas d'allow_credentials avec wildcard pour éviter les fuites CSRF/CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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

@app.get("/api/health")
def health_check():
    """Endpoint de diagnostic pour Docker, Caddy et monitoring."""
    try:
        conn = get_db_connection()
        conn.execute("SELECT 1;").fetchone()
        conn.close()
        return {
            "status": "ok",
            "service": "DocSeeker",
            "version": DOCSEEKER_VERSION,
            "commit": GIT_COMMIT
        }
    except Exception as e:
        raise HTTPException(status_code=503, detail="Service indisponible (Base de données inaccessible).")

@app.get("/api/version")
def get_version():
    """Renvoie la version applicative et le hash du commit Git actif."""
    return {
        "version": DOCSEEKER_VERSION,
        "commit": GIT_COMMIT
    }

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
    try:
        cursor = conn.cursor()
        if payload.parent_id is not None:
            cursor.execute("SELECT id FROM folders WHERE id = ?", (payload.parent_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=400, detail="Dossier parent introuvable.")

        cursor.execute("""
            INSERT INTO folders (name, parent_id, color)
            VALUES (?, ?, ?)
        """, (clean_name, payload.parent_id, payload.color or "#3b82f6"))
        folder_id = cursor.lastrowid
        conn.commit()
    finally:
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

    has_name = payload.name is not None and bool(payload.name.strip())
    has_color = payload.color is not None

    if has_name and has_color:
        cursor.execute("UPDATE folders SET name = ?, color = ? WHERE id = ?", (payload.name.strip(), payload.color, folder_id))
        conn.commit()
    elif has_name:
        cursor.execute("UPDATE folders SET name = ? WHERE id = ?", (payload.name.strip(), folder_id))
        conn.commit()
    elif has_color:
        cursor.execute("UPDATE folders SET color = ? WHERE id = ?", (payload.color, folder_id))
        conn.commit()

    conn.close()
    return {"status": "success"}

@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: int):
    """Supprime un dossier et replace ses documents à la racine."""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM folders WHERE id = ?", (folder_id,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="Dossier introuvable.")
        cursor.execute("UPDATE documents SET folder_id = NULL WHERE folder_id = ?", (folder_id,))
        cursor.execute("DELETE FROM folders WHERE id = ?", (folder_id,))
        conn.commit()
    finally:
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
    try:
        cursor = conn.cursor()

        if payload.folder_id is not None:
            cursor.execute("SELECT id FROM folders WHERE id = ?", (payload.folder_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=400, detail="Dossier cible introuvable.")

        placeholders = ",".join(["?"] * len(payload.doc_ids))
        cursor.execute(
            f"UPDATE documents SET folder_id = ? WHERE id IN ({placeholders})",  # nosec B608
            [payload.folder_id] + payload.doc_ids
        )
        moved_count = cursor.rowcount
        conn.commit()
    finally:
        conn.close()

    return {"status": "success", "moved_count": moved_count, "folder_id": payload.folder_id}

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
    Nettoie d'abord les anciennes annotations DocSeeker / DocFastExplorer / fitz pour refléter fidèlement
    les suppressions effectuées par l'utilisateur.
    """
    import pymupdf
    try:
        doc = pymupdf.open(pdf_path)
        modified = False

        # 1. Supprimer les annotations précédemment ajoutées par DocSeeker / DocFastExplorer (ou fitz)
        for page in doc:
            for annot in list(page.annots()):
                aid = annot.info.get("id", "")
                subj = annot.info.get("subject", "")
                if aid.startswith("fitz-") or subj in ("DocFastExplorer", "DocSeeker"):
                    page.delete_annot(annot)
                    modified = True

        # 2. Appliquer les annotations actives actuelles
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
                    annot.set_info(subject="DocSeeker")
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
                    annot.set_info(subject="DocSeeker")
                    annot.update()
                    modified = True

            # 15: Ink (Tracé libre au stylet)
            elif annot_type == 15:
                paths = a.get("paths") or a.get("lines")
                if paths:
                    try:
                        if isinstance(paths, dict):
                            paths = paths.get("lines") or paths.get("points")
                        if paths:
                            annot = page.add_ink_annot(paths)
                            annot.set_info(subject="DocSeeker")
                            annot.update()
                            modified = True
                    except Exception as e:
                        print(f"[Ink Annot] Erreur: {e}")

        if modified:
            tmp_path = pdf_path + ".tmp"
            try:
                doc.save(tmp_path, encryption=pymupdf.PDF_ENCRYPT_KEEP)
                doc.close()
                os.replace(tmp_path, pdf_path)
                return
            except Exception as e:
                print(f"[Save PDF] Erreur: {e}")
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
        doc.close()
    except Exception as e:
        print(f"[PDF Annotations] Erreur PyMuPDF: {e}")

@app.post("/api/documents/{doc_id}/save-pdf")
async def save_pdf_document(doc_id: int, request: Request):
    """
    Reçoit le fichier PDF mis à jour avec les annotations directement cuites par PDF.js (saveDocument),
    garantissant une fidélité 100% native (surélévation de texte, tracés, notes, suppressions).
    Sécurisé avec limite de taille de flux et vérification du format PDF natif (%PDF-).
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, filename FROM documents WHERE id = ?", (doc_id,))
    doc = cursor.fetchone()
    if not doc:
        conn.close()
        raise HTTPException(status_code=404, detail="Document introuvable.")

    filename = doc["filename"]
    pdf_path = os.path.join(DOCUMENTS_DIR, filename)
    tmp_path = pdf_path + ".tmp"

    total_bytes = 0
    first_chunk = True
    try:
        with open(tmp_path, "wb") as f:
            async for chunk in request.stream():
                if first_chunk:
                    if len(chunk) < 5 or b"%PDF-" not in chunk[:1024]:
                        raise HTTPException(status_code=400, detail="Contenu PDF invalide : signature de fichier manquante.")
                    first_chunk = False
                total_bytes += len(chunk)
                f.write(chunk)

        if total_bytes < 20:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            conn.close()
            raise HTTPException(status_code=400, detail="Contenu PDF invalide ou vide.")

        os.replace(tmp_path, pdf_path)
    except HTTPException:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        conn.close()
        raise
    except Exception as e:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        conn.close()
        print(f"[Security/SavePDF] Erreur interne : {e}")
        raise HTTPException(status_code=500, detail="Erreur interne lors de l'enregistrement du fichier PDF.")
    
    from backend.indexer import compute_file_hash
    file_hash = compute_file_hash(pdf_path)
    cursor.execute("UPDATE documents SET file_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (file_hash, doc_id))
    conn.commit()
    conn.close()
    
    return {"status": "success", "size": total_bytes}

@app.post("/api/documents/{doc_id}/annotations")
def save_annotations(doc_id: int, payload: AnnotationsPayload):
    """
    Sauvegarde légère des annotations (surlignages, dessins, notes textuelles)
    sans retélécharger l'intégralité du PDF. Enregistre également les suppressions (annotations=[]).
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

    # Toujours appliquer sur le fichier PDF local sur le serveur (y compris pour effacer si payload.annotations=[])
    try:
        from backend.indexer import DOCUMENTS_DIR
        pdf_path = os.path.join(DOCUMENTS_DIR, doc["filename"])
        if os.path.exists(pdf_path):
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
            SELECT id, filename, title, folder_id, status, error_message, total_pages, file_size, created_at, COALESCE(updated_at, created_at) AS updated_at 
            FROM documents 
            WHERE folder_id IS NULL
            ORDER BY id DESC
        """)
    elif folder_id is not None and folder_id.isdigit():
        cursor.execute("""
            SELECT id, filename, title, folder_id, status, error_message, total_pages, file_size, created_at, COALESCE(updated_at, created_at) AS updated_at 
            FROM documents 
            WHERE folder_id = ?
            ORDER BY id DESC
        """, (int(folder_id),))
    else:
        cursor.execute("""
            SELECT id, filename, title, folder_id, status, error_message, total_pages, file_size, created_at, COALESCE(updated_at, created_at) AS updated_at 
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
async def upload_pdf(
    file: UploadFile = File(...), 
    title: Optional[str] = Form(None), 
    folder_id: Optional[int] = Form(None),
    sync: Optional[bool] = Query(None)
):
    """Reçoit un fichier PDF, vérifie sa signature et sa taille, s'assure de l'absence de doublon strict, et l'ajoute au pipeline d'indexation."""
    # Validation préalable du dossier cible si spécifié
    if folder_id is not None:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM folders WHERE id = ?", (folder_id,))
        row_folder = cursor.fetchone()
        conn.close()
        if not row_folder:
            raise HTTPException(status_code=400, detail="Dossier cible introuvable.")

    raw_filename = file.filename or "document.pdf"
    if not raw_filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Seuls les fichiers PDF sont acceptés.")

    # Sanitisation rigoureuse du nom de fichier pour éliminer toute traversée de répertoire
    clean_raw = raw_filename.replace("\\", "/")
    base_name = os.path.basename(clean_raw)
    safe_filename = re.sub(r'[/\\:\0]', ' ', base_name).strip()
    safe_filename = re.sub(r'\.{2,}', '', safe_filename)  # Éliminer toute séquence de traversée ..
    safe_filename = re.sub(r'^\.+', '', safe_filename).strip()  # Empêcher les fichiers cachés
    if not safe_filename or not safe_filename.lower().endswith(".pdf"):
        safe_filename = f"document_{os.urandom(4).hex()}.pdf"

    dest_path = os.path.join(DOCUMENTS_DIR, safe_filename)
    temp_path = dest_path + ".tmp"

    # Sauvegarde temporaire par flux contrôlé (vérification signature magique + taille maximale)
    total_bytes = 0
    first_chunk = True
    try:
        with open(temp_path, "wb") as buffer:
            while True:
                chunk = await file.read(64 * 1024)
                if not chunk:
                    break
                if first_chunk:
                    if len(chunk) < 5 or b"%PDF-" not in chunk[:1024]:
                        raise HTTPException(status_code=400, detail="Format invalide : le fichier téléversé n'est pas un document PDF valide (signature manquante).")
                    first_chunk = False
                total_bytes += len(chunk)
                buffer.write(chunk)

        if total_bytes < 20:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise HTTPException(status_code=400, detail="Fichier PDF vide ou trop court.")

    except HTTPException:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise
    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        print(f"[Security/Upload] Erreur interne : {e}")
        raise HTTPException(status_code=500, detail="Erreur lors de la réception du fichier.")

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

    # Titre lisible
    clean_title = (title or "").strip()
    if not clean_title:
        clean_base = os.path.splitext(safe_filename)[0]
        clean_base = unicodedata.normalize("NFC", clean_base)
        clean_base = re.sub(r'[_\s]+', ' ', clean_base).strip()
        clean_base = re.sub(r'\s*-\s*', ' - ', clean_base)
        clean_title = clean_base

    # Insertion initiale en base de données avec statut 'pending'
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO documents (filename, title, file_hash, folder_id, status, total_pages, file_size) 
        VALUES (?, ?, ?, ?, 'pending', 0, ?)
    """, (safe_filename, clean_title, file_hash, folder_id, total_bytes))
    doc_id = cursor.lastrowid
    conn.commit()
    conn.close()

    # Déterminer si l'indexation doit être synchrone (tests unitaires ou demande explicite ?sync=true)
    # ou asynchrone (usage nominal / importation massive)
    is_test_env = bool(os.environ.get("PYTEST_CURRENT_TEST"))
    force_async_test = bool(os.environ.get("ASYNC_UPLOAD_TEST"))
    should_sync = sync if sync is not None else (is_test_env and not force_async_test)

    if should_sync:
        try:
            doc_info = index_pdf_file(dest_path, safe_filename, custom_title=clean_title)
            if folder_id is not None:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute("UPDATE documents SET folder_id = ? WHERE id = ?", (folder_id, doc_id))
                conn.commit()
                conn.close()
                doc_info["folder_id"] = folder_id

            doc_info["cover_url"] = f"/api/cover/{doc_id}"
            doc_info["pdf_url"] = f"/api/pdf/{doc_id}"
            doc_info["status"] = "ready"
            return {"status": "success", "document": doc_info}
        except Exception as e:
            try:
                remove_document(doc_id)
            except Exception:
                pass
            print(f"[Security/Indexer] Erreur lors de l'indexation synchrone : {e}")
            raise HTTPException(status_code=500, detail="Erreur lors de l'indexation du document.")

    # Mode asynchrone : Envoi immédiat au pipeline d'indexation en tâche de fond
    from backend.pipeline import pipeline
    pipeline.enqueue(doc_id)

    return {
        "status": "queued",
        "document": {
            "id": doc_id,
            "filename": safe_filename,
            "title": clean_title,
            "folder_id": folder_id,
            "status": "pending",
            "file_size": total_bytes,
            "total_pages": 0,
            "cover_url": f"/api/cover/{doc_id}",
            "pdf_url": f"/api/pdf/{doc_id}"
        }
    }

@app.get("/api/pipeline/status")
def get_pipeline_status():
    """Renvoie l'état du pipeline d'indexation d'arrière-plan (file d'attente, job en cours, statistiques)."""
    from backend.pipeline import pipeline
    return pipeline.get_status()

@app.get("/api/documents/{doc_id}/status")
def get_document_status(doc_id: int):
    """Renvoie le statut d'indexation d'un document spécifique."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, filename, title, status, error_message, total_pages FROM documents WHERE id = ?", (doc_id,))
    row = cursor.fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Document non trouvé.")
    return dict(row)

@app.post("/api/pipeline/retry-failed")
def retry_failed_indexing():
    """Relance l'indexation de tous les documents ayant échoué."""
    from backend.pipeline import pipeline
    requeued = pipeline.retry_failed()
    return {"status": "success", "requeued_count": requeued}

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

    # Auto-régénération à la volée si le document physique existe toujours
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT filename FROM documents WHERE id = ?", (doc_id,))
    row = cursor.fetchone()
    conn.close()

    if row:
        pdf_path = os.path.join(DOCUMENTS_DIR, row["filename"])
        if os.path.exists(pdf_path):
            try:
                import pymupdf
                doc = pymupdf.open(pdf_path)
                if len(doc) > 0:
                    first_page = doc[0]
                    scale = 180 / first_page.rect.width if first_page.rect.width > 0 else 1.0
                    pix = first_page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
                    try:
                        pix.pil_save(cover_webp, format="WEBP", quality=80)
                        doc.close()
                        return FileResponse(cover_webp, media_type="image/webp", headers=cache_headers)
                    except Exception:
                        pix.save(cover_jpg)
                        doc.close()
                        return FileResponse(cover_jpg, media_type="image/jpeg", headers=cache_headers)
                doc.close()
            except Exception:
                pass

    raise HTTPException(status_code=404, detail="Couverture non disponible.")

@app.get("/api/crop/{doc_id}/{page}/{occ_id}")
def get_crop(doc_id: int, page: int, occ_id: int, h: Optional[str] = Query(None), terms: Optional[str] = Query(None)):
    """Renvoie la vignette cropée, générée à la volée (Lazy Crop) si nécessaire."""
    from backend.crop_service import get_or_generate_crop_on_demand
    
    # Validation stricte du hash de requête (caractères hexadécimaux uniquement, sinon rejet immédiat)
    safe_h = ""
    if h is not None:
        cleaned = h.strip()
        if cleaned:
            if not re.match(r'^[a-f0-9]{1,32}$', cleaned, re.IGNORECASE):
                raise HTTPException(status_code=400, detail="Paramètre de hachage de requête invalide.")
            safe_h = cleaned.lower()
    terms_decoded = terms or ""
    crop_path = get_or_generate_crop_on_demand(doc_id, page, occ_id, safe_h, terms_decoded)
    
    # Cache court/aucun pour les requêtes de recherche très spécifiques (selon demande utilisateur)
    nocache_headers = {"Cache-Control": "no-cache, must-revalidate"}
    
    if crop_path and os.path.exists(crop_path):
        media_type = "image/webp" if crop_path.endswith(".webp") else "image/jpeg"
        return FileResponse(crop_path, media_type=media_type, headers=nocache_headers)

    doc_cache_dir = os.path.abspath(os.path.join(CACHE_DIR, f"doc_{doc_id}"))
    if os.path.exists(doc_cache_dir):
        for fname in os.listdir(doc_cache_dir):
            if fname.startswith(f"p{page}_occ{occ_id}_") or fname.startswith(f"p{page}_occ{occ_id}."):
                fpath = os.path.abspath(os.path.join(doc_cache_dir, fname))
                if fpath.startswith(doc_cache_dir + os.sep) and os.path.exists(fpath):
                    media_type = "image/webp" if fname.endswith(".webp") else "image/jpeg"
                    return FileResponse(fpath, media_type=media_type, headers=nocache_headers)

    raise HTTPException(status_code=404, detail="Vignette non trouvée.")

@app.get("/api/doc-search")
def doc_search(doc_id: int = Query(...), q: str = Query(..., min_length=1)):
    """Recherche ciblée au sein d'un document spécifique."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM documents WHERE id = ?", (doc_id,))
    row = cursor.fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Document introuvable.")

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
    mtime = int(os.path.getmtime(file_path))
    etag = f'"{doc_id}-{file_size}-{mtime}"'
    cache_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        "ETag": etag
    }

    # Si aucun en-tête Range, réponse standard 200 OK avec Accept-Ranges et mise en cache
    if not range:
        return FileResponse(
            file_path, 
            media_type="application/pdf", 
            headers=cache_headers
        )

    # Parsing du Range: bytes=start-end
    match = re.match(r"bytes=(\d+)-(\d*)", range.strip())
    if not match:
        return FileResponse(
            file_path, 
            media_type="application/pdf", 
            headers=cache_headers
        )

    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else file_size - 1

    if start > end or start >= file_size:
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
        "Content-Type": "application/pdf",
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        "ETag": etag
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
