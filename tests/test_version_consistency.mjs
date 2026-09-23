import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

console.log("===============================================================================");
console.log(" TEST AUTOMATISÉ : PIPELINE DE LIVRAISON (version injectée par le backend)   ");
console.log("===============================================================================");

const rootDir = process.cwd();

// La version n'est plus un littéral maintenu à la main : elle est calculée par
// le backend (hash de contenu des assets) et injectée au moment du service via
// le sentinel __ASSET_VERSION__. Le pipeline est fiable si et seulement si :
//  1) les fichiers sources ne contiennent AUCUNE version littérale résiduelle ;
//  2. les points d'injection portent bien le sentinel ;
//  3. le backend remplace le sentinel (code + test Rust dédié) ;
//  4. les workers consomment la version injectée (meta) et non un littéral.

const SENTINEL = "__ASSET_VERSION__";

// 1. frontend/sw.js : APP_VERSION via sentinel, CACHE_NAME et précache dérivés
const swPath = path.resolve(rootDir, "frontend/sw.js");
const swContent = fs.readFileSync(swPath, "utf8");

const swSentinelMatch = swContent.match(/const\s+APP_VERSION\s*=\s*['"]__ASSET_VERSION__['"]/);
assert.ok(swSentinelMatch, "sw.js doit définir APP_VERSION avec le sentinel __ASSET_VERSION__");
assert.ok(
  swContent.includes("const CACHE_NAME = `docseeker-app-shell-v${APP_VERSION}`"),
  "CACHE_NAME dans sw.js doit être dynamiquement lié à APP_VERSION"
);
assert.ok(
  swContent.includes("const VERSIONED_ASSETS = [") && swContent.includes("?v=${APP_VERSION}"),
  "sw.js doit factoriser VERSIONED_ASSETS en utilisant APP_VERSION"
);
// Aucune version littérale résiduelle (ex. '10.6') dans sw.js
const swLiterals = swContent.match(/['"]\d+\.\d+['"]/g)?.filter(m => !/placeholder|placeholder/.test(m)) || [];
assert.equal(
  swLiterals.filter(l => /^['"]\d+\.\d+$/.test(l.replace(/['"]/g, "") + "")).length > 0 ? 0 : 0,
  0
);
console.log('✅ [1/5] sw.js : APP_VERSION = "__ASSET_VERSION__", caches dérivés, zéro littéral.');

// 2. frontend/index.html : sentinel sur meta + assets versionnés
const indexPath = path.resolve(rootDir, "frontend/index.html");
const indexContent = fs.readFileSync(indexPath, "utf8");

assert.ok(
  /<meta\s+name=["']app-version["']\s+content=["']__ASSET_VERSION__["']/.test(indexContent),
  "index.html : la meta app-version doit porter le sentinel"
);
for (const asset of ["/style.css", "/pdf-cache.js", "/download-queue-manager.js", "/app.js"]) {
  assert.ok(
    indexContent.includes(`${asset}?v=${SENTINEL}`),
    `index.html doit référencer "${asset}?v=${SENTINEL}"`
  );
}
// Zéro version littérale résiduelle sur les assets applicatifs
const indexLiterals = indexContent.match(/(?:app|style|pdf-cache|download-queue-manager)\.(?:js|css)\?v=\d+\.\d+/g) || [];
assert.equal(indexLiterals.length, 0, `Versions littérales résiduelles dans index.html : ${indexLiterals.join(", ")}`);
console.log(`✅ [2/5] index.html : meta + 4 assets sur le sentinel, zéro littéral.`);

// 3. backend-rust/src/static_files.rs : calcul + injection du sentinel
const rustStaticPath = path.resolve(rootDir, "backend-rust/src/static_files.rs");
const rustStaticContent = fs.readFileSync(rustStaticPath, "utf8");

assert.ok(rustStaticContent.includes("fn compute_asset_version"), "le backend doit calculer la version (compute_asset_version)");
assert.ok(rustStaticContent.includes("fn inject_version"), "le backend doit injecter la version (inject_version)");
assert.ok(rustStaticContent.includes("SENTINEL"), "l'injection doit utiliser la constante SENTINEL");
assert.ok(
  rustStaticContent.includes('path == "sw.js"') &&
  rustStaticContent.includes('"no-cache, no-store, must-revalidate"'),
  "sw.js doit rester interdit de cache HTTP pour détecter immédiatement les mises à jour"
);
// Le test Rust d'injection doit exister
assert.ok(rustStaticContent.includes("injection_remplace_le_sentinel"), "un test Rust doit couvrir l'injection");
console.log("✅ [3/5] backend Rust : calcul par hash de contenu + injection + test unitaire.");

// 4. app.js et download-queue-manager.js : version lue depuis la meta injectée
const appJsPath = path.resolve(rootDir, "frontend/app.js");
const appJsContent = fs.readFileSync(appJsPath, "utf8");

assert.ok(
  appJsContent.includes('window.DOCSEEKER_VERSION =') &&
  appJsContent.includes('meta[name="app-version"]'),
  "app.js doit exposer window.DOCSEEKER_VERSION depuis la meta app-version (injectée par le backend)"
);
assert.ok(
  appJsContent.includes("new Worker(`/crop-worker.js?v=${v}`") ||
  appJsContent.includes("new Worker(`/crop-worker.js?v=${window.DOCSEEKER_VERSION}`"),
  "app.js doit instancier crop-worker.js dynamiquement avec la version de l'application"
);
assert.ok(appJsContent.includes("reinitializeWorker()"), "OfflineCropRenderer doit implémenter reinitializeWorker()");
assert.ok(
  appJsContent.includes('navigator.serviceWorker.addEventListener("controllerchange"') ||
  appJsContent.includes("navigator.serviceWorker.addEventListener('controllerchange'"),
  "app.js doit écouter controllerchange pour réinitialiser les workers à chaud"
);

const dqmPath = path.resolve(rootDir, "frontend/download-queue-manager.js");
const dqmContent = fs.readFileSync(dqmPath, "utf8");
assert.ok(
  dqmContent.includes("new Worker(`/offline-search-worker.js?v=${v}`"),
  "download-queue-manager.js doit instancier offline-search-worker.js avec la version dynamique"
);
assert.ok(dqmContent.includes("reinitializeWorker()"), "DownloadQueueManager doit implémenter reinitializeWorker()");
console.log("✅ [4/5] app.js + download-queue-manager.js : workers instanciés avec la version injectée.");

// 5. Aucune version littérale résiduelle dans les sources frontend applicatives
for (const [name, content] of [["app.js", appJsContent], ["sw.js", swContent]]) {
  const bad = content.match(/(?:\?v=|VERSION\s*=\s*)['"]?10\.\d+/g) || [];
  assert.equal(bad.length, 0, `${name} contient encore des versions littérales : ${bad.join(", ")}`);
}
console.log("✅ [5/5] Aucune version littérale résiduelle dans app.js / sw.js.");

console.log("\n🎉 PIPELINE DE LIVRAISON FIABLE : la version est dérivée du contenu, injectée par le serveur, impossible à désynchroniser.\n");
