/**
 * DocSeeker - Offline Search Worker
 * 
 * Web Worker dédié à la recherche hors-ligne combinant :
 * 1. SQLite-Wasm (FTS5 + BM25) pour la persistance locale haute performance (OPFS ou VFS standard).
 * 2. Rust-Wasm (search_wasm / search-core) comme SOURCE UNIQUE DE VÉRITÉ :
 *    - Le schéma DDL est généré par Rust (get_schema_sql)
 *    - La requête SQL FTS5 / BM25 est construite par Rust (build_search_sql_wasm)
 *    - L'algorithme spatial d'occurrences et de surlignage est exécuté par Rust (find_occurrences_wasm)
 * 
 * ZÉRO duplication de requête SQL ou de formule de scoring dans le JavaScript !
 */

import sqlite3InitModule from './wasm/sqlite/index.mjs';
import initSearchWasm, {
  get_schema_sql,
  get_insert_doc_sql,
  get_delete_doc_pages_sql,
  get_insert_page_sql,
  get_delete_all_folders_sql,
  get_insert_folder_sql,
  get_delete_doc_sql,
  get_cached_docs_sql,
  build_search_sql_wasm,
  build_title_search_sql_wasm,
  build_doc_search_sql_wasm,
  find_occurrences_wasm,
  process_search_results_wasm,
  process_doc_search_results_wasm,
  get_shared_constants_wasm,
  get_subfolder_ids_sql_wasm
} from './wasm/search_wasm/search_wasm.js';

let db = null;
let isReady = false;
let initPromise = null;

// Initialisation de la base SQLite locale et du module Wasm partagé
async function init() {
  if (isReady) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log('[OfflineSearchWorker] Initialisation du runtime SQLite-Wasm et Rust-Wasm...');
      
      // 1. Initialiser le module Rust-Wasm (chargement direct depuis CacheStorage si disponible pour résilience offline Firefox)
      let wasmBuffer = undefined;
      if (typeof caches !== 'undefined') {
        try {
          const wasmRes = await caches.match('/wasm/search_wasm/search_wasm_bg.wasm', { ignoreSearch: true }) ||
                          await caches.match('./wasm/search_wasm/search_wasm_bg.wasm', { ignoreSearch: true });
          if (wasmRes) {
            wasmBuffer = await wasmRes.arrayBuffer();
          }
        } catch (e) {
          console.warn('[OfflineSearchWorker] Impossible de lire search_wasm depuis CacheStorage:', e);
        }
      }
      await initSearchWasm(wasmBuffer);

      // 2. Initialiser SQLite-Wasm officiel (binaire depuis CacheStorage pour éviter l'échec XHR synchrone offline)
      let sqliteWasmBinary = undefined;
      if (typeof caches !== 'undefined') {
        try {
          const sqliteRes = await caches.match('/wasm/sqlite/sqlite3.wasm', { ignoreSearch: true }) ||
                            await caches.match('./wasm/sqlite/sqlite3.wasm', { ignoreSearch: true });
          if (sqliteRes) {
            sqliteWasmBinary = await sqliteRes.arrayBuffer();
          }
        } catch (e) {
          console.warn('[OfflineSearchWorker] Impossible de lire sqlite3.wasm depuis CacheStorage:', e);
        }
      }

      const sqliteConfig = {
        print: console.log,
        printErr: console.error,
      };
      if (sqliteWasmBinary) {
        sqliteConfig.wasmBinary = sqliteWasmBinary;
      }

      const sqlite3 = await sqlite3InitModule(sqliteConfig);

      // Tentative d'utilisation de l'OPFS haute performance, sinon fallback
      if (sqlite3.oo1 && sqlite3.oo1.OpfsDb) {
        try {
          db = new sqlite3.oo1.OpfsDb('/docseeker_local.sqlite');
          console.log('[OfflineSearchWorker] Base SQLite initialisée sur OPFS');
        } catch (opfsErr) {
          console.warn('[OfflineSearchWorker] OPFS indisponible, fallback VFS standard:', opfsErr);
          db = new sqlite3.oo1.DB('/docseeker_local.sqlite', 'c');
        }
      } else {
        console.warn('[OfflineSearchWorker] OpfsDb non disponible, fallback VFS standard');
        db = new sqlite3.oo1.DB('/docseeker_local.sqlite', 'c');
      }

      // 3. Application du schéma SQL généré DIRECTEMENT depuis Rust
      // Note: On maintient foreign_keys à OFF côté cache local pour éviter les suppressions en cascade
      // intempestives lors de la resynchronisation des dossiers
      const schemaSql = get_schema_sql();
      db.exec(`PRAGMA foreign_keys = OFF;\n` + schemaSql);

      isReady = true;
      console.log('[OfflineSearchWorker] Prêt pour la recherche locale BM25');
      return true;
    } catch (err) {
      console.error('[OfflineSearchWorker] Erreur fatale initialisation:', err);
      throw err;
    }
  })();

  return initPromise;
}

// Ingestion d'un paquet offline-bundle complet : SQL généré par Rust
function insertDocumentBundle(bundle) {
  if (!db || !bundle || !bundle.document) return false;

  const doc = bundle.document;
  const pages = bundle.pages || [];

  db.transaction(() => {
    // 1. Insertion ou mise à jour du document (requête mutualisée depuis Rust)
    db.exec({
      sql: get_insert_doc_sql(),
      bind: [
        doc.id,
        doc.filename,
        doc.title || doc.filename,
        doc.file_hash || null,
        doc.folder_id || null,
        doc.total_pages || pages.length,
        doc.file_size || 0,
        doc.created_at || new Date().toISOString(),
        doc.updated_at || new Date().toISOString()
      ]
    });

    // 2. Nettoyage des anciennes pages pour ce document
    db.exec({
      sql: get_delete_doc_pages_sql(),
      bind: [doc.id]
    });

    // 3. Insertion par lot des pages et de leurs coordonnées spatiales words
    const insertPageSql = get_insert_page_sql();
    for (const p of pages) {
      const wordsJsonStr = typeof p.words === 'string' ? p.words : JSON.stringify(p.words || []);
      db.exec({
        sql: insertPageSql,
        bind: [doc.id, p.page_number, p.text_content || '', wordsJsonStr]
      });
    }
  });

  return true;
}

// Ingestion ou synchronisation des dossiers : SQL mutualisé
function syncFolders(folders) {
  if (!db || !Array.isArray(folders)) return;
  db.transaction(() => {
    const insertFolderSql = get_insert_folder_sql();
    const currentIds = new Set();
    for (const f of folders) {
      currentIds.add(f.id);
      db.exec({
        sql: insertFolderSql,
        bind: [f.id, f.name, f.parent_id || null, f.color || '#3b82f6']
      });
    }
    // Nettoyer uniquement les dossiers qui ne sont plus présents
    if (folders.length > 0) {
      const idList = Array.from(currentIds).join(',');
      db.exec(`DELETE FROM folders WHERE id NOT IN (${idList})`);
    }
  });
}

// Synchronisation du rattachement des documents à leurs dossiers
function updateDocFolders(docs) {
  if (!db || !Array.isArray(docs)) return;
  db.transaction(() => {
    for (const d of docs) {
      if (d && d.id) {
        db.exec({
          sql: 'UPDATE documents SET folder_id = ? WHERE id = ?;',
          bind: [d.folder_id !== undefined ? d.folder_id : null, d.id]
        });
      }
    }
  });
}

// Récupération de tous les dossiers en cache local avec décompte des documents locaux
function getAllCachedFolders() {
  if (!db) return [];
  const folders = [];
  try {
    db.exec({
      sql: `SELECT f.id, f.name, f.parent_id, f.color, COUNT(d.id) AS doc_count 
            FROM folders f 
            LEFT JOIN documents d ON d.folder_id = f.id 
            GROUP BY f.id, f.name, f.parent_id, f.color 
            ORDER BY f.name ASC`,
      callback: (row) => {
        folders.push({
          id: row[0],
          name: row[1],
          parent_id: row[2],
          color: row[3] || '#3b82f6',
          doc_count: row[4] || 0
        });
      }
    });
  } catch (e) {
    console.error('[OfflineSearchWorker] Erreur getAllCachedFolders:', e);
  }
  return folders;
}

// Suppression d'un document local : SQL mutualisé
function deleteDocument(docId) {
  if (!db) return;
  db.transaction(() => {
    db.exec({ sql: get_delete_doc_pages_sql(), bind: [docId] });
    db.exec({ sql: get_delete_doc_sql(), bind: [docId] });
  });
}

// Récupération de la liste des documents en cache pour synchronisation : SQL mutualisé
function getCachedDocumentsList() {
  if (!db) return [];
  const rows = [];
  db.exec({
    sql: get_cached_docs_sql(),
    callback: (row) => {
      rows.push({
        id: row[0],
        file_hash: row[1],
        updated_at: row[2]
      });
    }
  });
  return rows;
}

// Récupération complète des documents pour l'affichage de la bibliothèque hors-ligne
function getAllCachedDocuments() {
  if (!db) return [];
  const docs = [];
  try {
    db.exec({
      sql: `SELECT id, filename, title, folder_id, total_pages, file_size, created_at, updated_at FROM documents ORDER BY title ASC`,
      callback: (row) => {
        docs.push({
          id: row[0],
          filename: row[1],
          title: row[2] || row[1],
          folder_id: row[3],
          total_pages: row[4] || 0,
          file_size: row[5] || 0,
          created_at: row[6],
          updated_at: row[7],
          cover_url: `/api/cover/${row[0]}`,
          status: 'ready',
          total_occurrences: 0,
          vignettes: []
        });
      }
    });
  } catch (e) {
    console.error('[OfflineSearchWorker] Erreur getAllCachedDocuments:', e);
  }
  return docs;
}


// Exécution de la recherche locale : la requête SQL est générée par Rust !
function executeSearch(queryStr, titlesOnly = false, folderId = null, limit = 15, offset = 0) {
  if (!db) {
    return {
      query: queryStr,
      query_hash: '',
      total_documents: 0,
      total_occurrences: 0,
      results: [],
      page: 1,
      limit,
      total_pages: 0,
      has_more: false
    };
  }

  // 1. Recherche dans les titres uniquement
  if (titlesOnly) {
    const titleSqlData = JSON.parse(build_title_search_sql_wasm(queryStr || '', folderId ? BigInt(folderId) : null, limit, offset));
    if (!titleSqlData.sql) {
      return {
        query: queryStr,
        query_hash: '',
        total_documents: 0,
        total_occurrences: 0,
        results: [],
        page: 1,
        limit,
        total_pages: 0,
        has_more: false
      };
    }

    const docs = [];
    db.exec({
      sql: titleSqlData.sql,
      callback: (r) => {
        docs.push({
          id: r[0],
          filename: r[1],
          title: r[2],
          folder_id: r[3],
          total_pages: r[4],
          created_at: r[5],
          updated_at: r[6],
          cover_url: `/api/cover/${r[0]}`,
          vignettes: [],
          occurrences_by_page: [],
          total_occurrences: 0,
          relevance_score: 1000.0,
          matched_all_terms: true
        });
      }
    });

    return {
      query: queryStr,
      query_hash: titleSqlData.query_hash,
      total_documents: docs.length,
      total_occurrences: 0,
      results: docs,
      page: Math.floor(offset / limit) + 1,
      limit,
      total_pages: Math.ceil(docs.length / limit),
      has_more: false
    };
  }

  // 2. Recherche complète FTS5 + BM25 : requête générée par Rust (search-core)
  const searchSqlData = JSON.parse(build_search_sql_wasm(queryStr || '', folderId ? BigInt(folderId) : null, limit, offset));
  if (!searchSqlData.sql || !searchSqlData.terms || searchSqlData.terms.length === 0) {
    return {
      query: queryStr,
      query_hash: '',
      total_documents: 0,
      total_occurrences: 0,
      results: [],
      page: 1,
      limit,
      total_pages: 0,
      has_more: false
    };
  }

  const { sql, terms, query_hash: queryHash } = searchSqlData;
  const termsJson = JSON.stringify(terms);

  let totalDocs = 0;
  let totalOccs = 0;
  const rawRows = [];

  try {
    db.exec({
      sql,
      callback: (row) => {
        const [
          docId, filename, title, fId, totalPages, createdAt, updatedAt,
          docRelevanceScore, matchingPagesCount, pageNumber, wordsJson, pageBm25,
          tDocs, tOccs
        ] = row;

        totalDocs = Number(tDocs) || 0;
        totalOccs = Number(tOccs) || 0;

        rawRows.push({
          doc_id: Number(docId),
          filename: filename || '',
          title: title || '',
          folder_id: fId !== null && fId !== undefined ? Number(fId) : null,
          total_pages: Number(totalPages) || 0,
          created_at: createdAt || '',
          updated_at: updatedAt || '',
          doc_relevance_score: Number(docRelevanceScore) || 0,
          matching_pages_count: Number(matchingPagesCount) || 0,
          page_number: Number(pageNumber) || 0,
          words_json: wordsJson || '[]',
          page_bm25: Number(pageBm25) || 0,
          total_docs: totalDocs,
          total_occurrences: totalOccs,
        });
      }
    });
  } catch (err) {
    console.error('[OfflineSearchWorker] Erreur exécution requête FTS5:', err);
  }

  // Traitement algorithmique 100% unifié (exécuté par search-core compilé en Wasm)
  const results = JSON.parse(process_search_results_wasm(
    JSON.stringify(rawRows),
    termsJson,
    queryHash
  ));

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(totalDocs / limit);

  return {
    query: queryStr,
    query_hash: queryHash,
    total_documents: totalDocs,
    total_occurrences: totalOccs,
    results,
    page: currentPage,
    limit,
    total_pages: totalPages,
    has_more: offset + results.length < totalDocs
  };
}

// Recherche au sein d'un document spécifique (Split View)
function executeDocSearch(docId, queryStr) {
  if (!db || !docId || !queryStr) return { doc_id: docId, query: queryStr, total_occurrences: 0, occurrences: [] };

  const docSqlData = JSON.parse(build_doc_search_sql_wasm(BigInt(docId), queryStr));
  if (!docSqlData.sql || !docSqlData.terms || docSqlData.terms.length === 0) {
    return { doc_id: docId, query: queryStr, total_occurrences: 0, occurrences: [] };
  }

  const { sql, terms, query_hash: queryHash } = docSqlData;
  const termsJson = JSON.stringify(terms);
  const allOccurrences = [];

  try {
    db.exec({
      sql,
      callback: (row) => {
        const [pageNumber, wordsJson, pageBm25] = row;
        if (wordsJson) {
          const occsRaw = find_occurrences_wasm(
            wordsJson,
            termsJson,
            queryHash,
            BigInt(docId),
            BigInt(pageNumber),
            pageBm25,
            842.0
          );
          const pageOccs = JSON.parse(occsRaw);
          allOccurrences.push(...pageOccs);
        }
      }
    });
  } catch (err) {
    console.error('[OfflineSearchWorker] Erreur doc_search:', err);
  }

  // Tri unifié par search-core Wasm
  const docResult = JSON.parse(process_doc_search_results_wasm(
    JSON.stringify(allOccurrences),
    null,
    null
  ));

  return {
    doc_id: docId,
    query: queryStr,
    total_occurrences: docResult.total_occurrences,
    occurrences: docResult.occurrences
  };
}

// Réception des messages
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  try {
    await init();

    switch (type) {
      case 'INSERT_BUNDLE': {
        const ok = insertDocumentBundle(payload.bundle);
        self.postMessage({ id, success: ok });
        break;
      }
      case 'SYNC_FOLDERS': {
        syncFolders(payload.folders);
        self.postMessage({ id, success: true });
        break;
      }
      case 'UPDATE_DOC_FOLDERS': {
        updateDocFolders(payload.docs);
        self.postMessage({ id, success: true });
        break;
      }
      case 'DELETE_DOCUMENT': {
        deleteDocument(payload.docId);
        self.postMessage({ id, success: true });
        break;
      }
      case 'GET_CACHED_DOCS': {
        const docs = getCachedDocumentsList();
        self.postMessage({ id, success: true, data: docs });
        break;
      }
      case 'GET_ALL_CACHED_DOCS': {
        const docs = getAllCachedDocuments();
        self.postMessage({ id, success: true, data: docs });
        break;
      }
      case 'GET_ALL_CACHED_FOLDERS': {
        const folders = getAllCachedFolders();
        self.postMessage({ id, success: true, data: folders });
        break;
      }
      case 'SEARCH': {
        const result = executeSearch(
          payload.query,
          payload.titlesOnly,
          payload.folderId,
          payload.limit,
          payload.offset
        );
        self.postMessage({ id, success: true, data: result });
        break;
      }
      case 'DOC_SEARCH': {
        const result = executeDocSearch(payload.docId, payload.query);
        self.postMessage({ id, success: true, data: result });
        break;
      }
      default:
        self.postMessage({ id, success: false, error: `Type de requête inconnu: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, success: false, error: err.message || String(err) });
  }
};
