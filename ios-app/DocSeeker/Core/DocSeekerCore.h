// DocSeekerCore.h
// C-ABI Header for DocSeeker Native iOS / iPadOS Client

#ifndef DocSeekerCore_h
#define DocSeekerCore_h

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Libère la mémoire d'une chaîne retournée par Rust
void docseeker_free_string(char* ptr);

/// Initialise la base de données SQLite locale avec le schéma officiel
/// et active les pragmas de performance (WAL mode, cache).
/// Retourne 0 en cas de succès, un code négatif en cas d'erreur.
int docseeker_init_db(const char* db_path);

/// Insère atomiquement un document et ses pages dans la base SQLite locale
/// à partir du JSON du bundle de synchronisation.
/// Retourne 0 en cas de succès, un code négatif en cas d'erreur.
int docseeker_insert_bundle(const char* db_path, const char* bundle_json);

/// Synchronise l'ensemble de l'arborescence des dossiers
/// Retourne 0 en cas de succès, un code négatif en cas d'erreur.
int docseeker_sync_folders(const char* db_path, const char* folders_json);

/// Supprime un document et ses pages de la base locale
/// Retourne 0 en cas de succès, un code négatif en cas d'erreur.
int docseeker_delete_doc(const char* db_path, int64_t doc_id);

/// Récupère la liste des documents indexés localement sous forme de JSON array
/// La chaîne retournée doit être libérée avec docseeker_free_string().
char* docseeker_get_cached_docs(const char* db_path);

/// Exécute une recherche globale FTS5 + BM25 locale avec scoring Goodnotes
/// Retourne un JSON conforme à SearchResponse.
/// La chaîne retournée doit être libérée avec docseeker_free_string().
char* docseeker_search_local(
    const char* db_path,
    const char* query,
    int64_t folder_id,
    int has_folder,
    size_t limit,
    size_t offset
);

/// Exécute la recherche au sein d'un document unique (pour le tiroir d'occurrences)
/// Retourne un JSON conforme à DocSearchResponse.
/// La chaîne retournée doit être libérée avec docseeker_free_string().
char* docseeker_doc_search_local(
    const char* db_path,
    int64_t doc_id,
    const char* query
);

/// Calcule les coordonnées optimales de cadrage pour un extrait (identique à crop.rs)
void docseeker_calculate_crop_bounds(
    double x0,
    double y0,
    double x1,
    double y1,
    double page_w,
    double page_h,
    double* out_x0,
    double* out_y0,
    double* out_w,
    double* out_h
);

#ifdef __cplusplus
}
#endif

#endif /* DocSeekerCore_h */
