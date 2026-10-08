import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import init, {
  initSync,
  get_schema_sql,
  build_title_search_sql_with_folders_wasm,
  get_upsert_doc_meta_sql,
  get_insert_doc_sql,
} from "../frontend/wasm/search_wasm/search_wasm.js";

console.log("===============================================================================");
console.log(" TEST DE NON-RÉGRESSION : COHÉRENCE RECHERCHE TITRES ET DOCUMENTS EN CACHE ");
console.log("===============================================================================");

// 1. Initialiser le Wasm
const wasmPath = path.resolve("./frontend/wasm/search_wasm/search_wasm_bg.wasm");
const wasmBuffer = fs.readFileSync(wasmPath);
initSync({ module: wasmBuffer });

const clientDb = new DatabaseSync(":memory:");
clientDb.exec("PRAGMA foreign_keys = OFF;");
clientDb.exec(get_schema_sql());
clientDb.exec("CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);");

// 2. Insérer doc 184 et doc 340 en meta-only via syncLibraryMeta
const upsertStmt = clientDb.prepare(get_upsert_doc_meta_sql());
upsertStmt.run(184, "184-accidents-travail.pdf", "184 - Accidents du travail et maladies professionnelles", null, 25, 2000000, null);
upsertStmt.run(340, "340-avc.pdf", "340 - Accidents vasculaires cérébraux", null, 30, 3000000, null);

// 3. Doc 184 est complètement indexé ('ready')
const insertDocStmt = clientDb.prepare(get_insert_doc_sql());
insertDocStmt.run(184, "184-accidents-travail.pdf", "184 - Accidents du travail et maladies professionnelles", "hash184", null, 25, 2000000, "2026-01-01", "2026-01-01");

// Doc 340 a son PDF en cache mais pas encore son bundle complet (reste 'meta-only')
const cachedDocIds = [184, 340];

// 4. Exécuter la requête telle que modifiée dans offline-search-worker.js
const titleSqlData = JSON.parse(build_title_search_sql_with_folders_wasm("accident", null, 15, 0));
assert.ok(titleSqlData.sql, "La requête SQL de titre doit être générée");

let sql = titleSqlData.sql;
if (Array.isArray(cachedDocIds) && cachedDocIds.length > 0) {
  const validIds = cachedDocIds.map(Number).filter(n => Number.isFinite(n) && n > 0);
  if (validIds.length > 0) {
    sql = sql.replace(
      "AND COALESCE(status, 'ready') = 'ready'",
      `AND (COALESCE(status, 'ready') = 'ready' OR id IN (${validIds.join(',')}))`
    );
  }
}

const docs = clientDb.prepare(sql).all();
console.log(`Documents trouvés pour "accident" : ${docs.length}`);
for (const d of docs) {
  console.log(` - #${d.id} : ${d.title}`);
}

assert.equal(docs.length, 2, "Les 2 documents (184 et 340) doivent être trouvés lors de la recherche dans les titres");
assert.ok(docs.some(d => d.id === 184), "Le doc 184 doit être présent");
assert.ok(docs.some(d => d.id === 340), "Le doc 340 doit être présent");

console.log("✅ Test de recherche de titre avec documents en cache validé avec succès !");
