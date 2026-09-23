/* tslint:disable */
/* eslint-disable */

export function build_doc_search_sql_wasm(doc_id: bigint, query: string): string;

export function build_search_sql_wasm(query: string, folder_id: bigint | null | undefined, limit: number, offset: number): string;

export function build_title_search_sql_wasm(query: string, folder_id: bigint | null | undefined, limit: number, offset: number): string;

export function calculate_crop_bounds_wasm(x0: number, y0: number, x1: number, y1: number, page_width: number, page_height: number, target_w?: number | null, target_h?: number | null): string;

export function compute_query_hash_wasm(terms_json: string): string;

export function find_occurrences_wasm(words_json: string, terms_json: string, query_hash: string, doc_id: bigint, page_number: bigint, bm25_score: number, page_height: number): string;

export function get_cached_docs_sql(): string;

export function get_delete_all_folders_sql(): string;

export function get_delete_doc_pages_sql(): string;

export function get_delete_doc_sql(): string;

export function get_insert_doc_sql(): string;

export function get_insert_folder_sql(): string;

export function get_insert_page_sql(): string;

export function get_schema_sql(): string;

export function get_shared_constants_wasm(): string;

export function get_subfolder_ids_sql_wasm(): string;

export function get_upsert_doc_meta_sql(): string;

/**
 * Tri et pagination des occurrences au sein d'un document (Split View)
 */
export function process_doc_search_results_wasm(occurrences_json: string, offset?: number | null, limit?: number | null): string;

/**
 * Post-traitement algorithmique complet (identique au serveur distant) exécuté en WebAssembly
 */
export function process_search_results_wasm(raw_rows_json: string, query_terms_json: string, query_hash: string): string;

export function sanitize_query_wasm(query: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly build_doc_search_sql_wasm: (a: bigint, b: number, c: number) => [number, number];
    readonly build_search_sql_wasm: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [number, number];
    readonly build_title_search_sql_wasm: (a: number, b: number, c: number, d: bigint, e: number, f: number) => [number, number];
    readonly calculate_crop_bounds_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly compute_query_hash_wasm: (a: number, b: number) => [number, number];
    readonly find_occurrences_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint, h: bigint, i: number, j: number) => [number, number];
    readonly get_cached_docs_sql: () => [number, number];
    readonly get_delete_all_folders_sql: () => [number, number];
    readonly get_delete_doc_pages_sql: () => [number, number];
    readonly get_delete_doc_sql: () => [number, number];
    readonly get_insert_doc_sql: () => [number, number];
    readonly get_insert_folder_sql: () => [number, number];
    readonly get_insert_page_sql: () => [number, number];
    readonly get_schema_sql: () => [number, number];
    readonly get_shared_constants_wasm: () => [number, number];
    readonly get_subfolder_ids_sql_wasm: () => [number, number];
    readonly get_upsert_doc_meta_sql: () => [number, number];
    readonly process_doc_search_results_wasm: (a: number, b: number, c: number, d: number) => [number, number];
    readonly process_search_results_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly sanitize_query_wasm: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
