import json
import re
from typing import List, Dict, Any
from backend.database import get_db_connection, normalize_text
from backend.crop_service import find_occurrences_on_page, generate_crop_image

def sanitize_fts_query(query: str) -> List[str]:
    """Nettoie la requête pour extraire les mots alphanumériques."""
    # Supprimer les caractères spéciaux réservés à FTS5
    cleaned = re.sub(r'[^\w\s]', ' ', query, flags=re.UNICODE)
    words = [w.strip() for w in cleaned.split() if len(w.strip()) > 1]
    return words

def search_documents(query: str) -> Dict[str, Any]:
    """
    Exécute la recherche multi-termes avec ranking de pertinence :
    1. Identification des pages et documents correspondants via FTS5.
    2. Calcul du score de pertinence combiné (BM25 + bonus exhaustivité de termes).
    3. Extraction des occurrences et génération/préparation des vignettes cropées.
    4. Tri hiérarchique : document le plus pertinent en haut.
    """
    terms = sanitize_fts_query(query)
    if not terms:
        return {"query": query, "total_matches": 0, "results": []}

    # Préparation des requêtes FTS5 (recherche par préfixe pour tolérance)
    # Ex: "hemorrag* AND delivr*"
    fts_and_query = " AND ".join([f"{normalize_text(t)}*" for t in terms])
    fts_or_query = " OR ".join([f"{normalize_text(t)}*" for t in terms])

    conn = get_db_connection()
    cursor = conn.cursor()

    # Requête avec FTS5 BM25
    # Note : bm25() dans SQLite FTS5 renvoie une valeur négative (plus c'est négatif, plus c'est pertinent)
    # On effectue la recherche en priorisant le match AND, puis OR
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

    # Si pas assez ou aucun résultat en AND strict, on tente en OR
    matched_doc_ids_and = {r["doc_id"] for r in rows}
    if len(rows) < 5 and len(terms) > 1:
        cursor.execute(sql, (fts_or_query,))
        or_rows = cursor.fetchall()
        # Ajouter les pages qui n'étaient pas déjà dans les résultats AND
        seen_keys = {(r["doc_id"], r["page_number"]) for r in rows}
        for r in or_rows:
            key = (r["doc_id"], r["page_number"])
            if key not in seen_keys:
                rows.append(r)
                seen_keys.add(key)

    if not rows:
        conn.close()
        return {"query": query, "total_matches": 0, "results": []}

    # Regroupement par document
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

    # Traiter chaque document pour extraire les vignettes cropées
    final_results = []
    total_matches_count = 0

    for doc_id, doc_info in doc_groups.items():
        vignettes = []
        for p_row in doc_info["pages_data"]:
            page_num = p_row["page_number"]
            try:
                words_data = json.loads(p_row["words_json"])
            except Exception:
                words_data = []

            occs = find_occurrences_on_page(words_data, terms)
            for occ in occs:
                # S'assurer que le fichier image de crop est généré
                generate_crop_image(doc_id, doc_info["filename"], page_num, occ)
                crop_url = f"/api/crop/{doc_id}/{page_num}/{occ['occ_id']}"
                vignettes.append({
                    "page_number": page_num,
                    "occ_id": occ["occ_id"],
                    "crop_url": crop_url,
                    "text_snippet": occ["text"]
                })

        doc_info["vignettes"] = vignettes
        doc_info["total_occurrences"] = len(vignettes)
        total_matches_count += len(vignettes)

        # Calcul du score de pertinence final pour le classement :
        # - Bonus majeur (1000 pts) si tous les termes recherchés sont présents
        # - Densité d'occurrences
        # - Score BM25 (converti en positif)
        relevance_score = 0.0
        if doc_info["matched_all_terms"]:
            relevance_score += 1000.0
        relevance_score += len(vignettes) * 10.0
        # BM25 négatif -> on inverse la magnitude
        relevance_score += abs(doc_info["best_bm25"]) * 100.0

        doc_info["relevance_score"] = round(relevance_score, 2)
        del doc_info["pages_data"]
        final_results.append(doc_info)

    # Tri : le document le plus pertinent en premier
    final_results.sort(key=lambda d: d["relevance_score"], reverse=True)

    # Marquer le premier document comme top match
    if final_results:
        final_results[0]["is_top_match"] = True

    conn.close()
    return {
        "query": query,
        "total_documents": len(final_results),
        "total_occurrences": total_matches_count,
        "results": final_results
    }
