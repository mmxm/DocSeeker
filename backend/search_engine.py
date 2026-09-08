import json
import re
import urllib.parse
from typing import List, Dict, Any, Optional
from backend.database import get_db_connection, normalize_text
from backend.crop_service import find_occurrences_on_page, get_query_hash

MAX_OCCURRENCES_PER_DOC = 25

def sanitize_fts_query(query: str) -> List[str]:
    """Nettoie la requête pour extraire les mots alphanumériques."""
    cleaned = re.sub(r'[^\w\s]', ' ', query, flags=re.UNICODE)
    words = [w.strip() for w in cleaned.split() if w.strip()]
    return words

def get_folder_and_subfolder_ids(folder_id: int) -> List[int]:
    """Retourne la liste des IDs du dossier et de toute son arborescence de sous-dossiers."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        WITH RECURSIVE subfolders AS (
            SELECT id FROM folders WHERE id = ?
            UNION ALL
            SELECT f.id FROM folders f JOIN subfolders s ON f.parent_id = s.id
        )
        SELECT id FROM subfolders;
    """, (folder_id,))
    ids = [row["id"] for row in cursor.fetchall()]
    conn.close()
    return ids

def term_matches_text(term: str, text: str) -> bool:
    """
    Vérifie si un terme de recherche correspond à un mot dans le texte (titre ou nom de fichier).
    - Respecte les frontières de mots pour éviter la pollution par sous-chaînes aléatoires
      (ex: 'car' ne doit PAS matcher 'brancardier').
    - Supporte le préfixe pour la recherche progressive et la dérivation (ex: 'complica' ou 'complication'
      matche 'complications').
    - Supporte la correspondance singulier/pluriel en français (ex: requête 'complications'
      matche un titre contenant 'complication').
    - Pour les termes très courts (<= 2 caractères, ex: 'en', 'de', 'B', '1'), exige une frontière
      stricte de mot entier pour éviter les faux positifs massifs sur les préfixes de 1-2 lettres.
    """
    if not term or not text:
        return False

    # Fast path C : Si ni le terme ni ses stems potentiels ne sont présents dans le texte, rejet immédiat
    # sans exécuter d'expression régulière coûteuse avec assertions lookaround.
    is_candidate = (term in text)
    if not is_candidate and len(term) > 3 and term.endswith(('s', 'x')):
        is_candidate = (term[:-1] in text)
    if not is_candidate and len(term) > 4 and term.endswith("aux"):
        is_candidate = ((term[:-3] + "al") in text)
    if not is_candidate:
        return False

    if len(term) <= 2:
        return bool(re.search(rf"(?<!\w){re.escape(term)}(?!\w)", text))
    if re.search(rf"(?<!\w){re.escape(term)}", text):
        return True
    if term.endswith(('s', 'x')) and len(term) > 3:
        stem = term[:-1]
        if re.search(rf"(?<!\w){re.escape(stem)}(?!\w)", text):
            return True
        if term.endswith("aux") and len(term) > 4:
            stem_al = term[:-3] + "al"
            if re.search(rf"(?<!\w){re.escape(stem_al)}(?!\w)", text):
                return True
    return False

def search_titles(query: str, folder_id: Optional[int] = None) -> Dict[str, Any]:
    """
    Recherche instantanée ciblée uniquement sur les titres et noms de fichiers.
    Ultra-rapide (0-5ms) car elle s'exécute directement sur les métadonnées de la table documents.
    """
    terms = sanitize_fts_query(query)
    if not terms:
        return {"query": query, "query_hash": "", "total_documents": 0, "total_occurrences": 0, "results": []}

    allowed_folder_ids = set(get_folder_and_subfolder_ids(folder_id)) if folder_id is not None else None

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, filename, title, folder_id, total_pages, created_at, COALESCE(updated_at, created_at) AS updated_at FROM documents WHERE COALESCE(status, 'ready') = 'ready'")
    all_docs = cursor.fetchall()
    conn.close()

    results = []
    norm_terms = [normalize_text(t) for t in terms if len(t.strip()) > 0]

    for doc in all_docs:
        if allowed_folder_ids is not None and doc["folder_id"] not in allowed_folder_ids:
            continue

        title_norm = normalize_text(doc["title"] or "")
        filename_norm = normalize_text(doc["filename"] or "")

        # Vérifier si tous les termes matchent le titre ou le nom de fichier
        matched_terms = 0
        for term in norm_terms:
            if term_matches_text(term, title_norm) or term_matches_text(term, filename_norm):
                matched_terms += 1

        # On ne retient que les documents dont le titre satisfait TOUS les termes recherchés
        if matched_terms == len(norm_terms):
            results.append({
                "id": doc["id"],
                "filename": doc["filename"],
                "title": doc["title"],
                "folder_id": doc["folder_id"],
                "total_pages": doc["total_pages"],
                "created_at": doc["created_at"],
                "updated_at": doc["updated_at"],
                "cover_url": f"/api/cover/{doc['id']}",
                "vignettes": [],
                "occurrences_by_page": [],
                "total_occurrences": 0,
                "relevance_score": 5000.0 + (100.0 if any(t == title_norm for t in norm_terms) else 0.0),
                "matched_all_terms": True
            })

    results.sort(key=lambda d: d["relevance_score"], reverse=True)

    return {
        "query": query,
        "query_hash": get_query_hash(terms),
        "total_documents": len(results),
        "total_occurrences": 0,
        "results": results
    }

def search_documents(query: str, titles_only: bool = False, folder_id: Optional[int] = None) -> Dict[str, Any]:
    """
    Exécute la recherche multi-termes ultra-rapide (Lazy Crop & Top 10) :
    Supporte titles_only=True et le filtrage par folder_id.
    """
    if titles_only:
        return search_titles(query, folder_id=folder_id)

    terms = sanitize_fts_query(query)
    if not terms:
        return {"query": query, "query_hash": "", "total_documents": 0, "total_occurrences": 0, "results": []}

    allowed_folder_ids = set(get_folder_and_subfolder_ids(folder_id)) if folder_id is not None else None

    query_hash = get_query_hash(terms)
    encoded_terms = urllib.parse.quote(",".join(terms))
    fts_and_query = " AND ".join([f"{normalize_text(t)}*" for t in terms])
    fts_or_query = " OR ".join([f"{normalize_text(t)}*" for t in terms])

    conn = get_db_connection()
    cursor = conn.cursor()

    sql = """
    SELECT 
        p.doc_id,
        p.page_number,
        p.words_json,
        d.filename,
        d.title,
        d.folder_id,
        d.total_pages,
        d.created_at,
        COALESCE(d.updated_at, d.created_at) as updated_at,
        bm25(pages_fts) as bm25_score
    FROM pages_fts
    JOIN pages p ON p.doc_id = pages_fts.doc_id AND p.page_number = pages_fts.page_number
    JOIN documents d ON d.id = p.doc_id
    WHERE pages_fts MATCH ?
    ORDER BY bm25_score ASC;
    """

    cursor.execute(sql, (fts_and_query,))
    raw_rows = cursor.fetchall()

    # Filtrer par folder_id si nécessaire
    rows = [r for r in raw_rows if allowed_folder_ids is None or r["folder_id"] in allowed_folder_ids]

    matched_doc_ids_and = {r["doc_id"] for r in rows}
    if len(rows) < 8 and len(terms) > 1:
        cursor.execute(sql, (fts_or_query,))
        or_rows = cursor.fetchall()
        seen_keys = {(r["doc_id"], r["page_number"]) for r in rows}
        for r in or_rows:
            if allowed_folder_ids is not None and r["folder_id"] not in allowed_folder_ids:
                continue
            key = (r["doc_id"], r["page_number"])
            if key not in seen_keys:
                rows.append(r)
                seen_keys.add(key)

    if not rows:
        conn.close()
        return {"query": query, "query_hash": query_hash, "total_documents": 0, "total_occurrences": 0, "results": []}

    doc_groups = {}
    for r in rows:
        doc_id = r["doc_id"]
        if doc_id not in doc_groups:
            doc_groups[doc_id] = {
                "id": doc_id,
                "filename": r["filename"],
                "title": r["title"],
                "folder_id": r["folder_id"],
                "total_pages": r["total_pages"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "cover_url": f"/api/cover/{doc_id}",
                "all_occurrences": [],
                "best_bm25": r["bm25_score"],
                "matched_all_terms": doc_id in matched_doc_ids_and,
                "total_occurrences": 0
            }
        if r["bm25_score"] < doc_groups[doc_id]["best_bm25"]:
            doc_groups[doc_id]["best_bm25"] = r["bm25_score"]

        # Traiter la page immédiatement au fil de l'eau pour libérer les gros blocs words_json
        page_num = r["page_number"]
        try:
            words_data = json.loads(r["words_json"])
        except Exception:
            words_data = []

        occs = find_occurrences_on_page(words_data, terms)
        for occ in occs:
            # Lazy URL : générée à la volée par le navigateur
            crop_url = f"/api/crop/{doc_id}/{page_num}/{occ['occ_id']}?h={query_hash}&terms={encoded_terms}"
            doc_groups[doc_id]["all_occurrences"].append({
                "page_number": page_num,
                "occ_id": occ["occ_id"],
                "crop_url": crop_url,
                "text_snippet": occ["text"],
                "distinct_terms_count": occ.get("distinct_terms_count", 1),
                "matched_terms": occ.get("matched_terms", []),
                "y_ratio": occ.get("y_ratio", 0.0),
                "y_pos": occ.get("y_pos", 0.0),
                "rect": occ.get("rect", [0, 0, 0, 0]),
                "bm25_score": r["bm25_score"]
            })

    final_results = []
    total_matches_count = 0

    for doc_id, doc_info in doc_groups.items():
        all_occurrences = doc_info.pop("all_occurrences")
        doc_info["total_occurrences"] = len(all_occurrences)
        total_matches_count += len(all_occurrences)

        # Vérifier si l'ensemble des termes de la recherche est présent à travers le document
        doc_matched_terms = set()
        for o in all_occurrences:
            for mt in o.get("matched_terms", []):
                doc_matched_terms.add(mt)
        if len(terms) > 1 and len(doc_matched_terms) >= len(terms):
            doc_info["matched_all_terms"] = True

        # 1. Ruban horizontal (vue générale) : ordonner par pertinence et plafonner aux meilleurs
        relevant_ribbon = sorted(
            all_occurrences,
            key=lambda x: (-x["distinct_terms_count"], x["bm25_score"], x["page_number"])
        )[:MAX_OCCURRENCES_PER_DOC]
        doc_info["vignettes"] = relevant_ribbon

        # 2. Split View (document ouvert) : TOUTES les occurrences du document ordonnées chronologiquement par page
        chronological_occs = sorted(all_occurrences, key=lambda x: (x["page_number"], x["occ_id"]))
        doc_info["occurrences_by_page"] = chronological_occs

        # Score global du document
        relevance_score = 0.0
        if doc_info["matched_all_terms"]:
            relevance_score += 1000.0
        relevance_score += len(all_occurrences) * 10.0
        relevance_score += abs(doc_info["best_bm25"]) * 100.0

        doc_info["relevance_score"] = round(relevance_score, 2)
        final_results.append(doc_info)

    # Tri des documents : les plus pertinents en tête
    final_results.sort(key=lambda d: d["relevance_score"], reverse=True)

    conn.close()
    return {
        "query": query,
        "query_hash": query_hash,
        "total_documents": len(final_results),
        "total_occurrences": total_matches_count,
        "results": final_results
    }

def search_within_document(doc_id: int, query: str) -> Dict[str, Any]:
    """
    Recherche instantanée ciblée à l'intérieur d'un unique document (Split View intra-search).
    """
    terms = sanitize_fts_query(query)
    if not terms:
        return {"doc_id": doc_id, "query": query, "total_occurrences": 0, "occurrences": []}

    query_hash = get_query_hash(terms)
    encoded_terms = urllib.parse.quote(",".join(terms))
    fts_and_query = " AND ".join([f"{normalize_text(t)}*" for t in terms])

    conn = get_db_connection()
    cursor = conn.cursor()

    sql = """
    SELECT 
        p.page_number,
        p.words_json,
        bm25(pages_fts) as bm25_score
    FROM pages_fts
    JOIN pages p ON p.doc_id = pages_fts.doc_id AND p.page_number = pages_fts.page_number
    WHERE pages_fts.doc_id = ? AND pages_fts MATCH ?
    ORDER BY p.page_number ASC;
    """

    cursor.execute(sql, (doc_id, fts_and_query))
    rows = cursor.fetchall()
    conn.close()

    occurrences = []
    for r in rows:
        page_num = r["page_number"]
        try:
            words_data = json.loads(r["words_json"])
        except Exception:
            words_data = []

        occs = find_occurrences_on_page(words_data, terms)
        for occ in occs:
            crop_url = f"/api/crop/{doc_id}/{page_num}/{occ['occ_id']}?h={query_hash}&terms={encoded_terms}"
            occurrences.append({
                "page_number": page_num,
                "occ_id": occ["occ_id"],
                "crop_url": crop_url,
                "text_snippet": occ["text"],
                "distinct_terms_count": occ.get("distinct_terms_count", 1),
                "y_ratio": occ.get("y_ratio", 0.0),
                "y_pos": occ.get("y_pos", 0.0),
                "rect": occ.get("rect", [0, 0, 0, 0]),
                "bm25_score": r["bm25_score"]
            })

    return {
        "doc_id": doc_id,
        "query": query,
        "total_occurrences": len(occurrences),
        "occurrences": occurrences[:25] # max 25 dans le document
    }
