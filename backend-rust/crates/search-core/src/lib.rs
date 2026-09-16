pub mod constants;
pub mod crop;
pub mod matching;
pub mod processing;
pub mod schema;
pub mod sql;
pub mod text_norm;
pub mod types;

// Re-exports directs des éléments les plus fréquents
pub use constants::*;
pub use crop::{calculate_crop_bounds, CropBounds};
pub use matching::{find_occurrences_on_page, get_query_hash, match_word, sanitize_fts_query};
pub use processing::{process_doc_search_results, process_search_results, RawSqlSearchRow};
pub use schema::get_full_schema_sql;
pub use sql::{
    build_doc_search_sql, build_search_query_sql, build_title_search_sql,
    DELETE_ALL_FOLDERS_SQL, DELETE_DOC_PAGES_SQL, DELETE_DOC_SQL, GET_CACHED_DOCS_SQL,
    GET_SUBFOLDER_IDS_SQL, INSERT_OR_REPLACE_DOC_SQL, INSERT_OR_REPLACE_FOLDER_SQL, INSERT_PAGE_SQL,
};
pub use text_norm::normalize_text;
pub use types::*;

