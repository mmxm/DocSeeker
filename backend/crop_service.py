import os
import re
import json
import hashlib
import pymupdf
from typing import List, Dict, Any, Tuple
from backend.database import get_db_connection, normalize_text

DOCUMENTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "documents")
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "cache_crops")

_RE_PUNCT_BOUNDARIES = re.compile(r'^\W+|\W+$')
_RE_WORD_TOKENS = re.compile(r'\w+')

def match_word(norm_w: str, term: str) -> bool:
    """
    Vérifie si un mot extrait du PDF correspond à un terme de recherche,
    même s'il est entouré de parenthèses ou ponctuation (ex: '(GEU)', 'GEU,', 'l'utérus', '«GEU»').
    """
    if not norm_w or not term:
        return False
    # 1. Correspondance exacte ou préfixe direct (le cas de 95%+ des correspondances)
    if norm_w == term or norm_w.startswith(term):
        return True
    # Fast path : si le mot est purement alphanumérique et ne commence pas par term,
    # seule une sous-chaîne >= 4 caractères peut matcher
    if norm_w.isalnum():
        return bool(len(term) >= 4 and term in norm_w)

    # 2. Nettoyage de la ponctuation entourant le mot (ex: "(geu)" -> "geu", "mot;" -> "mot")
    clean_w = _RE_PUNCT_BOUNDARIES.sub('', norm_w)
    if clean_w == term or clean_w.startswith(term):
        return True
    # 3. Décomposition en sous-mots alphanumériques (ex: "(geu)", "l'uterus", "geu/fiv")
    sub_tokens = _RE_WORD_TOKENS.findall(norm_w)
    for sub in sub_tokens:
        if sub == term or sub.startswith(term):
            return True
        if len(term) >= 4 and term in sub:
            return True
    # 4. Sous-chaîne pour termes d'au moins 4 caractères
    if len(term) >= 4 and term in clean_w:
        return True
    return False

def get_query_hash(query_terms: List[str]) -> str:
    """Calcule une empreinte courte et stable des termes de recherche."""
    norm_terms = sorted([normalize_text(t) for t in query_terms if len(t.strip()) > 1])
    return hashlib.md5(f"v4_{'_'.join(norm_terms)}".encode("utf-8"), usedforsecurity=False).hexdigest()[:8]

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
            if match_word(norm_w, term):
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

    # Regrouper uniquement les mots contigus d'une même expression sur la MÊME ligne
    occurrences = []
    current_occ = [matched_words[0]]

    for next_w in matched_words[1:]:
        prev_w = current_occ[-1]
        # Même bloc, strictement même ligne, et écart horizontal restreint (< 25pt)
        if (next_w["block_no"] == prev_w["block_no"] and 
            next_w["line_no"] == prev_w["line_no"] and 
            0 <= (next_w["rect"][0] - prev_w["rect"][2]) < 25):
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
            "matched_terms": list(set(w["matched_term"] for w in group)),
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

    # Format paysage Goodnotes optimisé pour une lisibilité maximale (~300x120pt)
    CROP_WIDTH = 300
    CROP_HEIGHT = 120

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
                if match_word(norm_w, term):
                    if len(term) < len(norm_w) and (norm_w.startswith(term) or term in norm_w):
                        # Sous-rectangle précis pour surligner uniquement la partie tronquée recherchée
                        sub_rects = page.search_for(term, clip=w_rect)
                        if not sub_rects:
                            sub_rects = page.search_for(w[4][:len(term)], clip=w_rect)
                        if sub_rects:
                            all_highlights.extend(sub_rects)
                        else:
                            ratio = min(1.0, len(term) / max(len(norm_w), 1))
                            approx_rect = pymupdf.Rect(w_rect.x0, w_rect.y0, w_rect.x0 + w_rect.width * ratio, w_rect.y1)
                            all_highlights.append(approx_rect)
                    else:
                        all_highlights.append(w_rect)
                    break

    if not all_highlights:
        for hl in occ_data.get("highlight_rects", [occ_data["rect"]]):
            all_highlights.append(pymupdf.Rect(hl[0], hl[1], hl[2], hl[3]))

    shape = page.new_shape()
    for hl_rect in all_highlights:
        expanded = pymupdf.Rect(hl_rect.x0 - 0.5, hl_rect.y0 - 0.5, hl_rect.x1, hl_rect.y1 + 0.5)
        shape.draw_rect(expanded)
    shape.finish(fill=(1.0, 0.88, 0.2), fill_opacity=0.5, stroke_opacity=0)
    shape.commit()

    pix = page.get_pixmap(clip=clip_rect, dpi=144, alpha=False)
    try:
        try:
            pix.pil_save(crop_path, format="WEBP", quality=80)
        except Exception:
            pix.save(crop_path)
    finally:
        del pix
        doc.close()

    return crop_path

def get_or_generate_crop_on_demand(doc_id: int, page_number: int, occ_id: int, query_hash: str, terms_str: str = "") -> str:
    """Génère la vignette à la demande (Lazy Crop) si elle n'est pas encore en cache."""
    # Sanitisation stricte de query_hash pour empêcher toute tentative de Path Traversal
    safe_hash = query_hash.strip() if query_hash else ""
    if safe_hash and not re.match(r'^[a-f0-9]{1,32}$', safe_hash):
        safe_hash = ""

    doc_cache_dir = os.path.abspath(os.path.join(CACHE_DIR, f"doc_{doc_id}"))
    os.makedirs(doc_cache_dir, exist_ok=True)
    
    crop_filename = f"p{page_number}_occ{occ_id}_{safe_hash}.webp" if safe_hash else f"p{page_number}_occ{occ_id}.webp"
    crop_path = os.path.abspath(os.path.join(doc_cache_dir, crop_filename))
    
    # Vérification de sécurité supplémentaire : confinement strict dans le répertoire de cache
    if not crop_path.startswith(doc_cache_dir + os.sep):
        return ""

    if os.path.exists(crop_path):
        return crop_path

    crop_jpg = os.path.abspath(os.path.join(doc_cache_dir, f"p{page_number}_occ{occ_id}_{safe_hash}.jpg" if safe_hash else f"p{page_number}_occ{occ_id}.jpg"))
    if not crop_jpg.startswith(doc_cache_dir + os.sep):
        return ""

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
