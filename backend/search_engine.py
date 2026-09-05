import json
import re
from typing import List, Dict, Any
from backend.database import get_db_connection, normalize_text
from backend.crop_service import find_occurrences_on_page, generate_crop_image, get_query_hash

def sanitize_fts_query(query: str) -> List[str]:
    """Nettoie la requête pour extraire les mots alphanumériques."""
    cleaned = re.sub(r'[^\w\s]', ' ', query, flags=re.UNICODE)
    words = [w.strip() for w in cleaned.split() if len(w.strip()) > 1]
    return words

def search_documents(query: str) -> Dict[str, Any]:
    """
    Exécute la recherche multi-termes avec ranking de pertinence :
    1. Identification des pages et documents via FTS5.
    2. Calcul du score de pertinence composite.
    3. Extraction des occurrences et génération des vignettes avec hash de requête.
    4. Ordonnancement :
       - Ruban horizontal : vignettes les plus pertinentes à gauche (multi-termes d'abord).
       - Liste verticale Split View : occurrences ordonnées chronologiquement par page.
    """
    terms = sanitize_fts_query(query)
    if not terms:
        return {"query": query, "total_matches": 0, "results": []}

    query_hash = get_query_hash(terms)
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
        d.total_pages,
        d.created_at,
        bm25(pages_fts) as bm25_score
    FROM pages_fts
    JOIN pages p ON p.doc_id = pages_fts.doc_id AND p.page_number = pages_fts.page_number
    JOIN documents d ON d.id = p.doc_id
    WHERE pages_fts MATCH ?
    ORDER BY bm25_score ASC;
    """

    cursor.execute(sql, (fts_and_query,))
    rows = cursor.fetchall()

    matched_doc_ids_and = {r["doc_id"] for r in rows}
    if len(rows) < 8 and len(terms) > 1:
        cursor.execute(sql, (fts_or_query,))
        or_rows = cursor.fetchall()
        seen_keys = {(r["doc_id"], r["page_number"]) for r in rows}
        for r in or_rows:
            key = (r["doc_id"], r["page_number"])
            if key not in seen_keys:
                rows.append(r)
                seen_keys.add(key)

    if not rows:
        conn.close()
        return {"query": query, "total_matches": 0, "results": []}

    doc_groups = {}
    for r in rows:
        doc_id = r["doc_id"]
        if doc_id not in doc_groups:
            doc_groups[doc_id] = {
                "id": doc_id,
                "filename": r["filename"],
                "title": r["title"],
                "total_pages": r["total_pages"],
                "created_at": r["created_at"],
                "cover_url": f"/api/cover/{doc_id}",
                "pages_data": [],
                "best_bm25": r["bm25_score"],
                "matched_all_terms": doc_id in matched_doc_ids_and,
                "total_occurrences": 0
            }
        doc_groups[doc_id]["pages_data"].append(r)
        if r["bm25_score"] < doc_groups[doc_id]["best_bm25"]:
            doc_groups[doc_id]["best_bm25"] = r["bm25_score"]

    final_results = []
    total_matches_count = 0

    for doc_id, doc_info in doc_groups.items():
        all_occurrences = []

        # Parcourir chaque page trouvée
        for p_row in doc_info["pages_data"]:
            page_num = p_row["page_number"]
            try:
                words_data = json.loads(p_row["words_json"])
            except Exception:
                words_data = []

            occs = find_occurrences_on_page(words_data, terms)
            for occ in occs:
                generate_crop_image(doc_id, doc_info["filename"], page_num, occ, terms, words_data)
                crop_url = f"/api/crop/{doc_id}/{page_num}/{occ['occ_id']}?h={query_hash}"
                all_occurrences.append({
                    "page_number": page_num,
                    "occ_id": occ["occ_id"],
                    "crop_url": crop_url,
                    "text_snippet": occ["text"],
                    "distinct_terms_count": occ.get("distinct_terms_count", 1),
                    "bm25_score": p_row["bm25_score"]
                })

        doc_info["total_occurrences"] = len(all_occurrences)
        total_matches_count += len(all_occurrences)

        # 1. Pour la Split View : occurrences triées par ordre chronologique de page
        chronological_occs = sorted(all_occurrences, key=lambda x: (x["page_number"], x["occ_id"]))
        doc_info["occurrences_by_page"] = chronological_occs

        # 2. Pour le ruban horizontal : occurrences triées par pertinence à gauche
        # Multi-mots d'abord, puis score BM25
        relevant_ribbon_vignettes = sorted(
            all_occurrences,
            key=lambda x: (-x["distinct_terms_count"], x["bm25_score"], x["page_number"])
        )
        doc_info["vignettes"] = relevant_ribbon_vignettes

        # Calcul du score de pertinence final pour le classement du document
        relevance_score = 0.0
        if doc_info["matched_all_terms"]:
            relevance_score += 1000.0
        relevance_score += len(all_occurrences) * 10.0
        relevance_score += abs(doc_info["best_bm25"]) * 100.0

        doc_info["relevance_score"] = round(relevance_score, 2)
        del doc_info["pages_data"]
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
