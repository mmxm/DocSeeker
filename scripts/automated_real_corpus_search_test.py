#!/usr/bin/env python3
"""
DocSeeker v2.0 - Suite de Tests Automatiques de Recherche sur Corpus Réel
Valide les performances, l'exhaustivité et l'intégrité des recherches
sur l'ensemble des documents réels du dossier data/.
"""

import os
import sys
import time
import json
import sqlite3
import unicodedata

def normalize(text):
    text = unicodedata.normalize('NFD', text)
    text = ''.join(c for c in text if not unicodedata.combining(c))
    return text.lower().replace('’', ' ').replace('\'', ' ')

def run_real_corpus_automated_tests():
    db_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'db.sqlite')
    if not os.path.exists(db_path):
        print(f"[ERREUR] Base de données introuvable : {db_path}")
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    total_docs = c.execute("SELECT count(*) FROM documents WHERE status = 'ready'").fetchone()[0]
    total_pages = c.execute("SELECT count(*) FROM pages").fetchone()[0]

    print("=========================================================================")
    print("      DocSeeker v2.0 - Tests Automatiques sur Corpus Réel                ")
    print(f"      Corpus : {total_docs} documents indexés, {total_pages} pages médicales")
    print("=========================================================================\n")

    if total_docs == 0 or total_pages == 0:
        print("[ERREUR] Le corpus est vide. Veuillez indexer des documents avant de tester.")
        sys.exit(1)

    test_queries = [
        # Requêtes très fréquentes (haute densité d'occurrences)
        ("patient", "Terme clinique omniprésent"),
        ("traitement", "Haute fréquence thérapeutique"),
        ("diagnostic", "Haute fréquence diagnostic"),
        ("clinique", "Haute fréquence examen clinique"),
        ("syndrome", "Terme nosologique médical"),
        ("douleur", "Symptôme fréquent"),
        ("chirurgie", "Terme chirurgical"),
        ("infection", "Infectiologie & bactériologie"),
        ("grossesse", "Obstétrique & gynécologie"),
        ("cancer", "Cancérologie & oncologie"),
        
        # Requêtes composées (multi-termes AND)
        ("traitement chirurgical", "Multi-termes : thérapeutique & chirurgie"),
        ("diagnostic clinique", "Multi-termes : diagnostic & signes"),
        ("douleur aigue", "Multi-termes : symptôme aigu"),
        ("femme enceinte", "Multi-termes : périnatalité"),
        
        # Recherche avec préfixe FTS5 (*)
        ("hemorrag*", "Préfixe : hémorragie, hémorragique"),
        ("vascul*", "Préfixe : vasculaire, vascularite, vascularisation"),
        ("diabet*", "Préfixe : diabète, diabétique"),
    ]

    all_passed = True
    results_summary = []

    for query, description in test_queries:
        terms = query.split()
        fts_match = ' AND '.join(f"{normalize(t)}*" if not t.endswith('*') else normalize(t) for t in terms)

        t_start = time.perf_counter()

        sql = """
            SELECT 
                p.doc_id,
                p.page_number,
                p.words_json,
                d.title,
                d.filename,
                bm25(pages_fts) as score
            FROM pages_fts
            JOIN pages p ON p.id = pages_fts.rowid
            JOIN documents d ON d.id = p.doc_id
            WHERE pages_fts MATCH ?
            ORDER BY score ASC;
        """

        try:
            rows = c.execute(sql, (fts_match,)).fetchall()
        except sqlite3.OperationalError as e:
            print(f"[FAIL] Erreur FTS5 sur '{query}' : {e}")
            all_passed = False
            continue

        matched_pages = len(rows)
        matched_docs = set()
        total_occurrences = 0
        invalid_occurrences = 0

        # Simulation streaming de désérialisation
        for row in rows:
            doc_id, page_num, words_json, title, filename, bm25_score = row
            matched_docs.add(doc_id)

            words = json.loads(words_json)
            for w in words:
                # w = [x0, y0, x1, y1, word_str, block, line]
                word_str = normalize(w[4])
                matches = False
                for t in terms:
                    clean_t = t.rstrip('*')
                    if clean_t in word_str:
                        matches = True
                        break
                if matches:
                    total_occurrences += 1
                    # Validation intégrité des coordonnées
                    x0, y0, x1, y1 = w[0], w[1], w[2], w[3]
                    if not (isinstance(x0, (int, f64 := float)) and isinstance(y0, (int, f64)) and x1 >= x0 and y1 >= y0):
                        invalid_occurrences += 1

        elapsed_ms = (time.perf_counter() - t_start) * 1000

        # Assertions : résultats trouvés, coordonnées valides, latence raisonnable
        passed = (matched_pages > 0) and (total_occurrences > 0) and (invalid_occurrences == 0) and (elapsed_ms < 15000)
        if not passed:
            all_passed = False

        status_str = "[PASS]" if passed else "[FAIL]"
        print(f"{status_str} '{query:<24}' | {matched_pages:>4} pages | {total_occurrences:>5} occ. | {len(matched_docs):>2} docs | {elapsed_ms:>6.2f} ms | {description}")

        results_summary.append({
            "query": query,
            "matched_pages": matched_pages,
            "total_occurrences": total_occurrences,
            "matched_docs": len(matched_docs),
            "elapsed_ms": elapsed_ms,
            "passed": passed
        })

    print("\n" + "="*73)
    avg_latency = sum(r['elapsed_ms'] for r in results_summary) / max(len(results_summary), 1)
    total_found = sum(r['total_occurrences'] for r in results_summary)
    print(f"RÉSUMÉ : {len(results_summary)} requêtes testées | {total_found} occurrences validées")
    print(f"Latence moyenne : {avg_latency:.2f} ms par recherche sur corpus entier")

    if all_passed:
        print("RÉSULTAT : 100% DES TESTS DE RECHERCHE ONT RÉUSSI AVEC SUCCÈS")
        print("="*73 + "\n")
        return 0
    else:
        print("RÉSULTAT : ÉCHEC SUR CERTAINES ASSERTIONS")
        print("="*73 + "\n")
        return 1

if __name__ == '__main__':
    sys.exit(run_real_corpus_automated_tests())
