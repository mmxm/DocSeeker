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
  get_upsert_doc_meta_sql,
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
  batch_find_and_process_doc_occurrences_wasm,
  process_search_results_wasm,
  process_doc_search_results_wasm,
  get_shared_constants_wasm,
  get_subfolder_ids_sql_wasm
} from './wasm/search_wasm/search_wasm.js';

let db = null;
let sqlite3Module = null;
let isReady = false;
let initPromise = null;
// Anti-boucle : au plus une réparation complète toutes les 5 secondes.
let lastRepairTimestamp = 0;

// Types d'opérations qui modifient la base : en cas de corruption, on répare
// puis on retente une fois avant d'abandonner.
const WRITE_RETRY_TYPES = new Set([
  'INSERT_BUNDLE', 'SYNC_FOLDERS', 'SYNC_LIBRARY_META',
  'UPDATE_DOC_FOLDERS', 'UPDATE_DOC_TOTAL_PAGES', 'DELETE_DOCUMENT'
]);

// Reconnaît les erreurs de corruption SQLite (SQLITE_CORRUPT*, incluant les
// index virtuels FTS5 : SQLITE_CORRUPT_VTAB) et le message générique
// "database disk image is malformed".
function isCorruptionError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  return /CORRUPT/i.test(msg) || /malformed/i.test(msg) || /disk image/i.test(msg);
}

// Suppression des fichiers SQLite (base + WAL/SHM/journal) via l'API OPFS native
async function deleteLocalDbFiles() {
  const names = [
    'docseeker_local.sqlite', 'docseeker_local.sqlite-wal',
    'docseeker_local.sqlite-shm', 'docseeker_local.sqlite-journal'
  ];
  try {
    const root = await navigator.storage.getDirectory();
    for (const n of names) {
      try { await root.removeEntry(n); } catch (_) { /* fichier absent */ }
    }
  } catch (e) {
    console.warn('[OfflineSearchWorker] Suppression OPFS impossible:', e);
  }
}

// Rouvre une base propre (OPFS si possible, sinon VFS standard)
function reopenFresh() {
  try { if (db) db.close(); } catch (_) { /* ignore */ }
  db = null;
  if (sqlite3Module && sqlite3Module.oo1 && sqlite3Module.oo1.OpfsDb) {
    try {
      db = new sqlite3Module.oo1.OpfsDb('/docseeker_local.sqlite');
    } catch (_) {
      db = new sqlite3Module.oo1.DB('/docseeker_local.sqlite', 'c');
    }
  } else {
    db = new sqlite3Module.oo1.DB('/docseeker_local.sqlite', 'c');
  }
}

// Rebuild seul des index FTS5 (opération qui préserve les données) : remonte
// les shadow tables depuis les tables de contenu. Retourne true en cas de succès.
function tryRebuildFts() {
  if (!db) return false;
  try {
    db.exec(`INSERT INTO pages_fts(pages_fts) VALUES('rebuild');`);
    db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild');`);
    console.log('[OfflineSearchWorker] Index FTS reconstruits (données conservées)');
    return true;
  } catch (e) {
    console.warn('[OfflineSearchWorker] Rebuild FTS impossible:', e);
    return false;
  }
}

// Réparation de la base locale corrompue (ex: SQLITE_CORRUPT_VTAB sur les
// index FTS5 external-content après un crash ou deux onglets écrivant
// simultanément sur l'OPFS). Stratégie en escalade :
//  1. rebuild FTS5 (sans perte de données) ;
//  2. recréation des objets FTS + rebuild (sans perte des métadonnées) ;
//  3. reconstruction complète de la base (perte du miroir local : les
//     métadonnées sont resynchronisées depuis le serveur et les documents
//     déjà téléchargés dans le cache OPFS sont réindexés automatiquement) ;
//  4. suppression du fichier + réinitialisation à neuf.
// Retourne true si une base utilisable est en place.
async function repairDatabase() {
  const now = Date.now();
  if (now - lastRepairTimestamp < 5000) {
    return !!db;
  }
  lastRepairTimestamp = now;

  console.warn('[OfflineSearchWorker] Réparation de la base locale...');
  try { if (db) db.exec('ROLLBACK'); } catch (_) { /* pas de transaction en cours */ }

  // Niveau 1 : rebuild des index FTS5
  if (tryRebuildFts()) {
    try {
      db.exec({ sql: `SELECT count(*) FROM documents_fts`, callback: () => { } });
      console.log('[OfflineSearchWorker] Base réparée (niveau 1)');
      return true;
    } catch (_) { /* continuer l'escalade */ }
  }

  // Niveau 2 : recréation des objets FTS (table virtuelle + shadow + triggers)
  for (const tbl of ['pages_fts', 'documents_fts']) {
    try {
      const objs = [];
      db.exec({
        sql: `SELECT type, name FROM sqlite_master WHERE name LIKE '${tbl}%' OR (type='trigger' AND sql LIKE '%${tbl}%')`,
        callback: (r) => objs.push({ type: r[0], name: r[1] })
      });
      for (const o of objs) {
        try {
          db.exec(`DROP ${o.type === 'trigger' ? 'TRIGGER' : 'TABLE'} IF EXISTS "${o.name}"`);
        } catch (_) { /* ignoré, recréé ensuite */ }
      }
      db.exec(`PRAGMA foreign_keys = OFF;\n` + get_schema_sql());
      db.exec(`INSERT INTO ${tbl}(${tbl}) VALUES('rebuild');`);
      console.log(`[OfflineSearchWorker] ${tbl} recréé et reconstruit (niveau 2)`);
    } catch (e2) {
      console.warn(`[OfflineSearchWorker] Recréation ${tbl} impossible:`, e2);
    }
  }
  try {
    db.exec({ sql: `SELECT count(*) FROM documents_fts`, callback: () => { } });
    console.log('[OfflineSearchWorker] Base réparée (niveau 2)');
    return true;
  } catch (_) { /* continuer l'escalade */ }

  // Niveau 3 : reconstruction complète (les tables de contenu sont recréées
  // vides ; la synchro et la réindexation depuis le cache PDF les repeuplent)
  console.warn('[OfflineSearchWorker] Niveau 3 : reconstruction complète de la base');
  try {
    const names = [];
    db.exec({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      callback: (r) => names.push(r[0])
    });
    for (const n of names) {
      try { db.exec(`DROP TABLE IF EXISTS "${n}"`); } catch (_) { /* ignoré */ }
    }
    db.exec(`PRAGMA foreign_keys = OFF;\n` + get_schema_sql());
    db.exec('VACUUM;');
    db.exec({ sql: `SELECT count(*) FROM documents_fts`, callback: () => { } });
    console.log('[OfflineSearchWorker] Base reconstruite (niveau 3)');
    return true;
  } catch (e3) {
    console.error('[OfflineSearchWorker] Reconstruction impossible:', e3);
  }

  // Niveau 4 : suppression du fichier + réouverture à neuf
  console.warn('[OfflineSearchWorker] Niveau 4 : suppression du fichier de base');
  try { if (db) db.close(); } catch (_) { /* ignore */ }
  db = null;
  await deleteLocalDbFiles();
  try {
    reopenFresh();
    db.exec(`PRAGMA foreign_keys = OFF;\n` + get_schema_sql());
    console.log('[OfflineSearchWorker] Base réinitialisée (niveau 4)');
  } catch (e4) {
    console.error('[OfflineSearchWorker] Réinitialisation impossible:', e4);
  }
  return !!db; // les opérations suivantes retentent sur la base neuve
}

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
      if (wasmBuffer) {
        await initSearchWasm({ module_or_path: wasmBuffer });
      } else {
        await initSearchWasm();
      }

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
      sqlite3Module = sqlite3;

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

      // Sonde d'intégrité : un index FTS5 external-content corrompu échoue dès la
      // première lecture (SQLITE_CORRUPT_VTAB). Mieux vaut réparer maintenant que
      // laisser chaque écriture échouer en silence pendant toute la session.
      try {
        db.exec({ sql: `SELECT count(*) FROM documents_fts`, callback: () => { } });
        db.exec({ sql: `SELECT count(*) FROM documents`, callback: () => { } });
      } catch (probeErr) {
        console.warn('[OfflineSearchWorker] Sonde d\'intégrité en échec:', probeErr);
        await repairDatabase();
        if (!db) throw probeErr;
      }
      // Backfill idempotent de l'index documents_fts (recherche titres) : les
      // bases locales créées avant l'introduction de l'index doivent être
      // reconstruites une seule fois (même logique que le backend).
      try {
        let ftsCount = 0, docsCount = 0;
        db.exec({
          sql: `SELECT (SELECT count(*) FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid), (SELECT count(*) FROM documents)`,
          callback: (r) => { ftsCount = r[0]; docsCount = r[1]; }
        });
        if (docsCount > 0 && ftsCount !== docsCount) {
          db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild');`);
          console.log('[OfflineSearchWorker] Index documents_fts reconstruit (' + docsCount + ' documents)');
        }
      } catch (e) {
        console.warn('[OfflineSearchWorker] Backfill documents_fts ignoré:', e);
      }

      isReady = true;
      console.log('[OfflineSearchWorker] Prêt pour la recherche locale BM25');
      return true;
    } catch (err) {
      console.error('[OfflineSearchWorker] Erreur fatale initialisation:', err);
      // Réinitialiser la promesse : le message suivant retentera une
      // initialisation complète (et donc une éventuelle réparation).
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

// Exécute une lecture (recherche) ; en cas de corruption, répare la base puis
// retente une fois.
async function runReadWithRepair(fn) {
  try {
    return fn();
  } catch (err) {
    if (isCorruptionError(err) && await repairDatabase()) {
      try {
        return fn();
      } catch (retryErr) {
        console.error('[OfflineSearchWorker] Recherche en échec après réparation:', retryErr);
        throw retryErr;
      }
    }
    throw err;
  }
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
    if (typeof db.prepare === 'function') {
      const stmt = db.prepare(insertPageSql);
      try {
        for (const p of pages) {
          const wordsJsonStr = typeof p.words === 'string' ? p.words : JSON.stringify(p.words || []);
          stmt.bind([doc.id, p.page_number, p.text_content || '', wordsJsonStr]);
          stmt.step();
          stmt.reset();
        }
      } finally {
        stmt.finalize();
      }
    } else {
      for (const p of pages) {
        const wordsJsonStr = typeof p.words === 'string' ? p.words : JSON.stringify(p.words || []);
        db.exec({
          sql: insertPageSql,
          bind: [doc.id, p.page_number, p.text_content || '', wordsJsonStr]
        });
      }
    }
  });

  return true;
}

function stripMarkdown(md) {
  if (!md) return '';
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/---+/g, '')
    .trim();
}

function indexMarkdownDocument({ docId, filename, title, content }) {
  if (!db || !filename) return false;
  const cleanText = stripMarkdown(content);
  const now = new Date().toISOString();
  const numericId = Number(docId) || Math.floor(Math.random() * 1000000000);

  db.transaction(() => {
    // 1. Insertion ou mise à jour du document markdown
    db.exec({
      sql: `INSERT INTO documents (id, filename, title, total_pages, file_size, status, doc_type, created_at, updated_at)
            VALUES (?1, ?2, ?3, 1, ?4, 'ready', 'markdown', ?5, ?5)
            ON CONFLICT(id) DO UPDATE SET
              filename = excluded.filename,
              title = excluded.title,
              file_size = excluded.file_size,
              status = 'ready',
              doc_type = 'markdown',
              updated_at = excluded.updated_at`,
      bind: [numericId, filename, title || filename, (content || '').length, now]
    });

    // 2. Nettoyage des anciennes pages pour ce document
    db.exec({
      sql: get_delete_doc_pages_sql(),
      bind: [numericId]
    });

    // 3. Insertion de la page unique (déclenche trigger FTS5 automatique)
    db.exec({
      sql: get_insert_page_sql(),
      bind: [numericId, 1, cleanText, "[]"]
    });
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

// Miroir de la bibliothèque complète : dossiers + métadonnées de TOUS les
// documents (y compris non téléchargés). Un doc miroir est marqué
// 'meta-only' : visible dans l'arborescence hors-ligne mais clairement non
// consultable sans réseau. Les docs réellement indexés ('ready') ne sont
// jamais rétrogradés par la synchro.
function syncLibraryMeta(documents) {
  if (!db || !Array.isArray(documents)) return;

  const validDocs = documents.filter(d => d && d.id);
  const currentIds = new Set(validDocs.map(d => d.id));

  db.transaction(() => {
    // 1. Purger les anciens miroirs 'meta-only' qui n'existent plus sur le serveur (ex: après réindexation)
    if (currentIds.size > 0) {
      const idList = Array.from(currentIds).join(',');
      try {
        db.exec(`DELETE FROM documents WHERE status = 'meta-only' AND id NOT IN (${idList});`);
      } catch (e) {
        console.warn('[OfflineSearchWorker] Erreur purge orphelins meta-only:', e);
        if (isCorruptionError(e)) {
          try {
            db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild');`);
            db.exec(`DELETE FROM documents WHERE status = 'meta-only' AND id NOT IN (${idList});`);
            console.log('[OfflineSearchWorker] Purge orphelins réussie après rebuild documents_fts');
          } catch (retryErr) {
            console.warn('[OfflineSearchWorker] Retry purge après rebuild FTS échoué:', retryErr);
            if (isCorruptionError(retryErr)) throw retryErr;
          }
        }
      }
    }

    const upsertMetaSql = get_upsert_doc_meta_sql();

    for (const d of validDocs) {
      const fname = d.filename || `doc-${d.id}.pdf`;

      // 2. Éviter le conflit d'unicité (SQLITE_CONSTRAINT_UNIQUE rc=2067) sur documents.filename :
      // Si un ancien document miroir existe avec le même nom de fichier mais un ID obsolète, le supprimer
      try {
        db.exec({
          sql: "DELETE FROM documents WHERE filename = ? AND id != ? AND status = 'meta-only';",
          bind: [fname, d.id]
        });

        // Si le document a déjà été téléchargé localement ('ready') mais que son ID a changé sur le serveur :
        db.exec({
          sql: "UPDATE pages SET doc_id = ? WHERE doc_id = (SELECT id FROM documents WHERE filename = ? AND id != ?);",
          bind: [d.id, fname, d.id]
        });
        db.exec({
          sql: "UPDATE documents SET id = ? WHERE filename = ? AND id != ?;",
          bind: [d.id, fname, d.id]
        });
      } catch (e) {
        console.warn('[OfflineSearchWorker] Reconcile stale filename:', e);
        if (isCorruptionError(e)) {
          try {
            db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild');`);
          } catch (_) { }
        }
      }

      try {
        db.exec({
          sql: upsertMetaSql,
          bind: [
            d.id,
            fname,
            d.title || d.filename || `Document ${d.id}`,
            (d.folder_id === undefined ? null : d.folder_id),
            d.total_pages || 0,
            d.file_size || 0,
            d.created_at || null
          ]
        });
      } catch (err) {
        console.warn(`[OfflineSearchWorker] Sync meta doc ${d.id} (${fname}):`, err);
        if (isCorruptionError(err)) {
          try {
            db.exec(`INSERT INTO documents_fts(documents_fts) VALUES('rebuild');`);
          } catch (_) { }
          throw err;
        }
      }
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

// Persistance du nombre de pages réel (remonté par PDF.js)
function updateDocTotalPages(docId, totalPages) {
  if (!db || !docId || !Number.isFinite(totalPages) || totalPages <= 0) return;
  try {
    db.exec({
      sql: 'UPDATE documents SET total_pages = ? WHERE id = ?;',
      bind: [totalPages, docId]
    });
  } catch (e) {
    // Laisser remonter une corruption pour que le wrapper déclenche la réparation
    if (isCorruptionError(e)) throw e;
    console.warn('[OfflineSearchWorker] updateDocTotalPages:', e);
  }
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
      sql: `SELECT id, filename, title, folder_id, total_pages, file_size, created_at, updated_at FROM documents WHERE status != 'meta-only' ORDER BY title ASC`,
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

// Tous les documents connus (indexés + miroir 'meta-only'), avec le statut
// réel de chacun pour que l'UI distingue consultable hors-ligne / meta seule.
function getAllKnownDocuments() {
  if (!db) return [];
  const docs = [];
  try {
    db.exec({
      sql: `SELECT id, filename, title, folder_id, total_pages, file_size, created_at, updated_at, status FROM documents ORDER BY title ASC`,
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
          status: row[8] === 'meta-only' ? 'meta-only' : 'ready',
          cover_url: `/api/cover/${row[0]}`,
          total_occurrences: 0,
          vignettes: []
        });
      }
    });
  } catch (e) {
    console.error('[OfflineSearchWorker] Erreur getAllKnownDocuments:', e);
  }
  return docs;
}


// Exécution de la recherche locale : la requête SQL est générée par Rust !
async function executeSearch(queryStr, titlesOnly = false, folderId = null, limit = 15, offset = 0) {
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
    await runReadWithRepair(() => db.exec({
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
    }));

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
    await runReadWithRepair(() => db.exec({
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
    }));
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
async function executeDocSearch(docId, queryStr) {
  if (!db || !docId || !queryStr) return { doc_id: docId, query: queryStr, total_occurrences: 0, occurrences: [] };

  const docSqlData = JSON.parse(build_doc_search_sql_wasm(BigInt(docId), queryStr));
  if (!docSqlData.sql || !docSqlData.terms || docSqlData.terms.length === 0) {
    return { doc_id: docId, query: queryStr, total_occurrences: 0, occurrences: [] };
  }

  const { sql, terms, query_hash: queryHash } = docSqlData;
  const termsJson = JSON.stringify(terms);
  const rows = [];

  try {
    await runReadWithRepair(() => db.exec({
      sql,
      callback: (row) => {
        if (row) {
          rows.push({
            pageNumber: Number(row[0]),
            wordsJson: row[1] || "[]",
            bm25: Number(row[2]) || 0.0,
            textContent: row[3] || ""
          });
        }
      }
    }));
  } catch (err) {
    console.error('[OfflineSearchWorker] Erreur doc_search:', err);
  }

  if (rows.length === 0) {
    return { doc_id: docId, query: queryStr, total_occurrences: 0, occurrences: [] };
  }

  // Séparer les pages PDF avec words_json des pages Markdown avec textContent
  const pdfRows = [];
  const textOccurrences = [];

  for (const r of rows) {
    if (r.wordsJson && r.wordsJson !== "[]") {
      pdfRows.push([r.pageNumber, r.wordsJson, r.bm25]);
    } else if (r.textContent && r.textContent.trim().length > 0) {
      // Extraction textuelle pour note Markdown
      const lines = r.textContent.split("\n");
      const totalLen = Math.max(1, r.textContent.length);
      let currentOffset = 0;
      let occId = 0;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lowerLine = line.toLowerCase();
        const matched = terms.filter(t => lowerLine.includes(t.toLowerCase()));
        if (matched.length > 0) {
          const yRatio = Math.min(1.0, currentOffset / totalLen);
          const snippet = line.length > 140 ? `...${line.slice(0, 140)}...` : line.trim();
          textOccurrences.push({
            page_number: r.pageNumber,
            occ_id: occId++,
            crop_url: "",
            text_snippet: snippet,
            distinct_terms_count: matched.length,
            matched_terms: matched,
            y_ratio: Math.round(yRatio * 1000) / 1000,
            y_pos: lineIdx * 20.0,
            rect: [0.0, lineIdx * 20.0, 500.0, (lineIdx + 1) * 20.0],
            highlight_rects: [],
            bm25_score: r.bm25,
            font_size: 14.0
          });
        }
        currentOffset += line.length + 1;
      }
    }
  }

  let finalOccurrences = textOccurrences;
  if (pdfRows.length > 0) {
    const docResult = JSON.parse(batch_find_and_process_doc_occurrences_wasm(
      JSON.stringify(pdfRows),
      termsJson,
      queryHash,
      BigInt(docId),
      842.0,
      null,
      null
    ));
    finalOccurrences = (docResult.occurrences || []).concat(textOccurrences);
  }

  return {
    doc_id: docId,
    query: queryStr,
    total_occurrences: finalOccurrences.length,
    occurrences: finalOccurrences
  };
}

// Exécute un handler d'écriture ; en cas de corruption, répare la base puis
// retente une fois (les données perdues sont resynchronisées / réindexées).
async function runWriteWithRepair(type, fn) {
  try {
    return fn();
  } catch (err) {
    if (isCorruptionError(err) && await repairDatabase()) {
      try {
        const result = fn();
        console.warn(`[OfflineSearchWorker] ${type}: réécrit avec succès après réparation`);
        return result;
      } catch (retryErr) {
        console.error(`[OfflineSearchWorker] ${type}: échec après réparation:`, retryErr);
        throw retryErr;
      }
    }
    throw err;
  }
}

// Réception des messages
self.onmessage = async (e) => {
  const { id, type, payload } = e.data;

  try {
    await init();

    switch (type) {
      case 'INSERT_BUNDLE': {
        const ok = await runWriteWithRepair(type, () => insertDocumentBundle(payload.bundle));
        self.postMessage({ id, success: ok });
        break;
      }
      case 'INDEX_MARKDOWN_DOC': {
        const ok = await runWriteWithRepair(type, () => indexMarkdownDocument(payload));
        self.postMessage({ id, success: ok });
        break;
      }
      case 'SYNC_FOLDERS': {
        await runWriteWithRepair(type, () => syncFolders(payload.folders));
        self.postMessage({ id, success: true });
        break;
      }
      case 'SYNC_LIBRARY_META': {
        try {
          await runWriteWithRepair(type, () => {
            if (Array.isArray(payload.folders)) syncFolders(payload.folders);
            syncLibraryMeta(payload.documents);
          });
          self.postMessage({ id, success: true });
        } catch (e) {
          self.postMessage({ id, success: false, error: String(e && e.message || e) });
        }
        break;
      }
      case 'UPDATE_DOC_FOLDERS': {
        await runWriteWithRepair(type, () => updateDocFolders(payload.docs));
        self.postMessage({ id, success: true });
        break;
      }
      case 'UPDATE_DOC_TOTAL_PAGES': {
        await runWriteWithRepair(type, () => updateDocTotalPages(payload.docId, payload.totalPages));
        self.postMessage({ id, success: true });
        break;
      }
      case 'DELETE_DOCUMENT': {
        await runWriteWithRepair(type, () => deleteDocument(payload.docId));
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
      case 'GET_ALL_KNOWN_DOCS': {
        // Tous les documents connus localement (indexés 'ready' + miroir 'meta-only')
        const known = getAllKnownDocuments();
        self.postMessage({ id, success: true, data: known });
        break;
      }
      case 'SEARCH': {
        const result = await executeSearch(
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
        const result = await executeDocSearch(payload.docId, payload.query);
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
