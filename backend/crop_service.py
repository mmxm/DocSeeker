import os
import json
import hashlib
import pymupdf
from typing import List, Dict, Any, Tuple
from backend.database import get_db_connection, normalize_text

DOCUMENTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "documents")
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "cache_crops")

def get_query_hash(query_terms: List[str]) -> str:
    """Calcule une empreinte courte et stable des termes de recherche."""
    norm_terms = sorted([normalize_text(t) for t in query_terms if len(t.strip()) > 1])
    return hashlib.md5("_".join(norm_terms).encode("utf-8")).hexdigest()[:8]

def find_occurrences_on_page(words_data: List[List[Any]], query_terms: List[str], page_height: float = 842.0) -> List[Dict[str, Any]]:
    """
    Parcourt les mots d'une page et extrait les occurrences correspondantes aux termes.
    words_data: [ [x0, y0, x1, y1, word, block_no, line_no], ... ]
    """
    norm_terms = [normalize_text(t) for t in query_terms if len(t.strip()) > 1]
    if not norm_terms:
        return []

    matched_words = []
    for idx, w in enumerate(words_data):
        norm_w = normalize_text(w[4])
        for term in norm_terms:
            if norm_w == term or norm_w.startswith(term) or (term in norm_w and len(term) >= 4):
                matched_words.append({
                    "rect": (w[0], w[1], w[2], w[3]),
                    "word": w[4],
                    "block_no": w[5],
                    "line_no": w[6],
                    "matched_term": term,
                    "index": idx
                })
                break

    if not matched_words:
        return []

    # Regrouper les mots contigus ou proches sur la même ligne
    occurrences = []
    current_occ = [matched_words[0]]

    for next_w in matched_words[1:]:
        prev_w = current_occ[-1]
        if next_w["block_no"] == prev_w["block_no"] and abs(next_w["line_no"] - prev_w["line_no"]) <= 1:
            current_occ.append(next_w)
        else:
            occurrences.append(current_occ)
            current_occ = [next_w]

    if current_occ:
        occurrences.append(current_occ)

    query_hash = get_query_hash(query_terms)

    results = []
    for occ_idx, group in enumerate(occurrences):
        x0 = min(w["rect"][0] for w in group)
        y0 = min(w["rect"][1] for w in group)
        x1 = max(w["rect"][2] for w in group)
        y1 = max(w["rect"][3] for w in group)

        occ_text = " ".join(w["word"] for w in group)
        matched_distinct_terms = len(set(w["matched_term"] for w in group))
        
        # Position relative pour scroll direct dans le viewer PDF
        y_ratio = round(max(0.0, min(1.0, y0 / page_height)), 3) if page_height > 0 else 0.0

        results.append({
            "occ_id": occ_idx,
            "rect": (x0, y0, x1, y1),
            "y_pos": round(y0, 1),
            "y_ratio": y_ratio,
            "highlight_rects": [w["rect"] for w in group],
            "text": occ_text,
            "distinct_terms_count": matched_distinct_terms,
            "query_hash": query_hash
        })

    return results

def generate_crop_image(doc_id: int, filename: str, page_number: int, occ_data: Dict[str, Any], query_terms: List[str], words_data: List[List[Any]]) -> str:
    """
    Génère l'image cropée zoomée avec surbrillance de tous les termes de la recherche dans la zone.
    Sauvegarde dans le cache sous f"p{page_number}_occ{occ_id}_{query_hash}.jpg".
    """
    doc_cache_dir = os.path.join(CACHE_DIR, f"doc_{doc_id}")
    os.makedirs(doc_cache_dir, exist_ok=True)

    occ_id = occ_data.get("occ_id", 0)
    query_hash = occ_data.get("query_hash") or get_query_hash(query_terms)
    crop_filename = f"p{page_number}_occ{occ_id}_{query_hash}.webp"
    crop_path = os.path.join(doc_cache_dir, crop_filename)

    if os.path.exists(crop_path):
        return crop_path

    crop_jpg = os.path.join(doc_cache_dir, f"p{page_number}_occ{occ_id}_{query_hash}.jpg")
    if os.path.exists(crop_jpg):
        return crop_jpg

    pdf_path = os.path.join(DOCUMENTS_DIR, filename)
    if not os.path.exists(pdf_path):
        return ""

    doc = pymupdf.open(pdf_path)
    page_idx = page_number - 1
    if page_idx < 0 or page_idx >= len(doc):
        doc.close()
        return ""

    page = doc[page_idx]
    page_rect = page.rect

    # Dimensions du mot trouvé
    x0, y0, x1, y1 = occ_data["rect"]
    occ_center_x = (x0 + x1) / 2
    occ_center_y = (y0 + y1) / 2

    # Format paysage Goodnotes ~340x130pt
    CROP_WIDTH = 340
    CROP_HEIGHT = 130

    crop_x0 = max(page_rect.x0, occ_center_x - CROP_WIDTH / 2)
    crop_x1 = min(page_rect.x1, crop_x0 + CROP_WIDTH)
    if crop_x1 == page_rect.x1:
        crop_x0 = max(page_rect.x0, crop_x1 - CROP_WIDTH)

    crop_y0 = max(page_rect.y0, occ_center_y - CROP_HEIGHT / 2)
    crop_y1 = min(page_rect.y1, crop_y0 + CROP_HEIGHT)
    if crop_y1 == page_rect.y1:
        crop_y0 = max(page_rect.y0, crop_y1 - CROP_HEIGHT)

    clip_rect = pymupdf.Rect(crop_x0, crop_y0, crop_x1, crop_y1)

    # Identifier TOUS les mots de la page situés dans la zone de crop qui correspondent aux termes
    norm_terms = [normalize_text(t) for t in query_terms if len(t.strip()) > 1]
    all_highlights = []

    for w in words_data:
        w_rect = pymupdf.Rect(w[0], w[1], w[2], w[3])
        if clip_rect.intersects(w_rect):
            norm_w = normalize_text(w[4])
            for term in norm_terms:
                if norm_w == term or norm_w.startswith(term) or (term in norm_w and len(term) >= 4):
                    all_highlights.append(w_rect)
                    break

    if not all_highlights:
        for hl in occ_data.get("highlight_rects", [occ_data["rect"]]):
            all_highlights.append(pymupdf.Rect(hl[0], hl[1], hl[2], hl[3]))

    shape = page.new_shape()
    for hl_rect in all_highlights:
        expanded = pymupdf.Rect(hl_rect.x0 - 1, hl_rect.y0 - 1, hl_rect.x1 + 1, hl_rect.y1 + 1)
        shape.draw_rect(expanded)
    shape.finish(fill=(1.0, 0.88, 0.2), fill_opacity=0.5, stroke_opacity=0)
    shape.commit()

    pix = page.get_pixmap(clip=clip_rect, dpi=144, alpha=False)
    try:
        pix.pil_save(crop_path, format="WEBP", quality=80)
    except Exception:
        pix.save(crop_path)

    doc.close()
    return crop_path

def get_or_generate_crop_on_demand(doc_id: int, page_number: int, occ_id: int, query_hash: str, terms_str: str = "") -> str:
    """Génère la vignette à la demande (Lazy Crop) si elle n'est pas encore en cache."""
    doc_cache_dir = os.path.join(CACHE_DIR, f"doc_{doc_id}")
    os.makedirs(doc_cache_dir, exist_ok=True)
    
    crop_filename = f"p{page_number}_occ{occ_id}_{query_hash}.webp" if query_hash else f"p{page_number}_occ{occ_id}.webp"
    crop_path = os.path.join(doc_cache_dir, crop_filename)
    if os.path.exists(crop_path):
        return crop_path

    crop_jpg = os.path.join(doc_cache_dir, f"p{page_number}_occ{occ_id}_{query_hash}.jpg" if query_hash else f"p{page_number}_occ{occ_id}.jpg")
    if os.path.exists(crop_jpg):
        return crop_jpg

    # Génération à la volée
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT p.words_json, d.filename 
        FROM pages p 
        JOIN documents d ON d.id = p.doc_id 
        WHERE p.doc_id = ? AND p.page_number = ?
    """, (doc_id, page_number))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return ""

    try:
        words_data = json.loads(row["words_json"])
    except Exception:
        words_data = []

    terms = [t for t in terms_str.split(",") if t.strip()]
    occs = find_occurrences_on_page(words_data, terms)
    target_occ = next((o for o in occs if o["occ_id"] == occ_id), None)
    if not target_occ and occs:
        target_occ = occs[0]

    if target_occ:
        return generate_crop_image(doc_id, row["filename"], page_number, target_occ, terms, words_data)
    return ""
