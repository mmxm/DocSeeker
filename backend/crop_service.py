import os
import json
import hashlib
import pymupdf
from typing import List, Dict, Any, Tuple
from backend.database import get_db_connection, normalize_text

DOCUMENTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "documents")
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "cache_crops")

def find_occurrences_on_page(words_data: List[List[Any]], query_terms: List[str]) -> List[Dict[str, Any]]:
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
        # Correspondance exacte ou préfixe (ex: "hemorrag" match "hemorragie")
        for term in norm_terms:
            if term in norm_w or norm_w.startswith(term):
                matched_words.append({
                    "rect": (w[0], w[1], w[2], w[3]),
                    "word": w[4],
                    "block_no": w[5],
                    "line_no": w[6],
                    "index": idx
                })
                break

    if not matched_words:
        return []

    # Regrouper les mots contigus ou proches sur la même ligne pour ne pas créer 2 vignettes identiques
    occurrences = []
    current_occ = [matched_words[0]]

    for next_w in matched_words[1:]:
        prev_w = current_occ[-1]
        # Même bloc et même ligne ou ligne consécutive immédiate
        if next_w["block_no"] == prev_w["block_no"] and abs(next_w["line_no"] - prev_w["line_no"]) <= 1:
            current_occ.append(next_w)
        else:
            occurrences.append(current_occ)
            current_occ = [next_w]

    if current_occ:
        occurrences.append(current_occ)

    # Pour chaque groupe d'occurrence, calculer la bounding box globale et le texte contextuel
    results = []
    for occ_idx, group in enumerate(occurrences):
        x0 = min(w["rect"][0] for w in group)
        y0 = min(w["rect"][1] for w in group)
        x1 = max(w["rect"][2] for w in group)
        y1 = max(w["rect"][3] for w in group)

        # Snippet textuel (texte de l'occurrence)
        occ_text = " ".join(w["word"] for w in group)

        results.append({
            "occ_id": occ_idx,
            "rect": (x0, y0, x1, y1),
            "highlight_rects": [w["rect"] for w in group],
            "text": occ_text
        })

    return results

def generate_crop_image(doc_id: int, filename: str, page_number: int, occ_data: Dict[str, Any]) -> str:
    """
    Génère l'image cropée zoomée avec surbrillance du mot-clé et sauvegarde dans le cache.
    Renvoie le chemin du fichier image généré.
    """
    doc_cache_dir = os.path.join(CACHE_DIR, f"doc_{doc_id}")
    os.makedirs(doc_cache_dir, exist_ok=True)

    occ_id = occ_data.get("occ_id", 0)
    crop_filename = f"p{page_number}_occ{occ_id}.jpg"
    crop_path = os.path.join(doc_cache_dir, crop_filename)

    if os.path.exists(crop_path):
        return crop_path

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

    # Calcul du rectangle de crop (format paysage agréable ~350x120pt, comme Goodnotes)
    CROP_WIDTH = 340
    CROP_HEIGHT = 130

    crop_x0 = max(page_rect.x0, occ_center_x - CROP_WIDTH / 2)
    crop_x1 = min(page_rect.x1, crop_x0 + CROP_WIDTH)
    # Réajustement si bord droit touché
    if crop_x1 == page_rect.x1:
        crop_x0 = max(page_rect.x0, crop_x1 - CROP_WIDTH)

    crop_y0 = max(page_rect.y0, occ_center_y - CROP_HEIGHT / 2)
    crop_y1 = min(page_rect.y1, crop_y0 + CROP_HEIGHT)
    if crop_y1 == page_rect.y1:
        crop_y0 = max(page_rect.y0, crop_y1 - CROP_HEIGHT)

    clip_rect = pymupdf.Rect(crop_x0, crop_y0, crop_x1, crop_y1)

    # Surligner les mots trouvés avec un rectangle jaune translucide
    shape = page.new_shape()
    for hl in occ_data.get("highlight_rects", [occ_data["rect"]]):
        # Étendre légèrement pour un rendu propre de surligneur
        hl_rect = pymupdf.Rect(hl[0] - 1, hl[1] - 1, hl[2] + 1, hl[3] + 1)
        shape.draw_rect(hl_rect)
    shape.finish(fill=(1.0, 0.88, 0.2), fill_opacity=0.5, stroke_opacity=0)
    shape.commit()

    # Rendu haute fidélité (DPI 144)
    pix = page.get_pixmap(clip=clip_rect, dpi=144, alpha=False)
    pix.save(crop_path)

    doc.close()
    return crop_path
