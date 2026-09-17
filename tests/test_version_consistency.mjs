import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

console.log("===============================================================================");
console.log(" TEST AUTOMATISÉ : CONSISTANCE DU VERSIONING ET GESTION DU CYCLE DE VIE CACHE  ");
console.log("===============================================================================");

const rootDir = process.cwd();

// 1. Lire frontend/sw.js et extraire APP_VERSION
const swPath = path.resolve(rootDir, "frontend/sw.js");
const swContent = fs.readFileSync(swPath, "utf8");

const swVersionMatch = swContent.match(/const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
assert.ok(swVersionMatch, "sw.js doit définir une constante unique 'APP_VERSION'");
const appVersion = swVersionMatch[1];
console.log(`✅ [1/5] sw.js définit APP_VERSION = "${appVersion}".`);

assert.ok(
  swContent.includes("const CACHE_NAME = `docseeker-app-shell-v${APP_VERSION}`") ||
  swContent.includes(`const CACHE_NAME = 'docseeker-app-shell-v${appVersion}'`),
  "CACHE_NAME dans sw.js doit être dynamiquement lié à APP_VERSION"
);
assert.ok(
  swContent.includes("const VERSIONED_ASSETS = [") && swContent.includes(`?v=\${APP_VERSION}`),
  "sw.js doit factoriser VERSIONED_ASSETS en utilisant APP_VERSION"
);

// 2. Vérifier frontend/index.html
const indexPath = path.resolve(rootDir, "frontend/index.html");
const indexContent = fs.readFileSync(indexPath, "utf8");

const metaVersionMatch = indexContent.match(/<meta\s+name=["']app-version["']\s+content=["']([^"']+)["']/);
assert.ok(metaVersionMatch, "index.html doit définir la balise meta <meta name=\"app-version\" content=\"...\">");
assert.equal(
  metaVersionMatch[1],
  appVersion,
  `La version dans index.html (${metaVersionMatch[1]}) ne correspond pas à celle de sw.js (${appVersion}) !`
);

const expectedIndexAssets = [
  `/style.css?v=${appVersion}`,
  `/pdf-cache.js?v=${appVersion}`,
  `/download-queue-manager.js?v=${appVersion}`,
  `/app.js?v=${appVersion}`,
];
for (const asset of expectedIndexAssets) {
  assert.ok(
    indexContent.includes(asset),
    `index.html doit référencer l'asset versionné exact "${asset}"`
  );
}
console.log(`✅ [2/5] index.html est strictement synchronisé avec la version ${appVersion}.`);

// 3. Vérifier frontend/app.js (Workers dynamiques et gestion controllerchange)
const appJsPath = path.resolve(rootDir, "frontend/app.js");
const appJsContent = fs.readFileSync(appJsPath, "utf8");

assert.ok(
  appJsContent.includes("window.DOCSEEKER_VERSION ="),
  "app.js doit exposer window.DOCSEEKER_VERSION comme source de vérité d'exécution"
);
assert.ok(
  appJsContent.includes("new Worker(`/crop-worker.js?v=${v}`") ||
  appJsContent.includes("new Worker(`/crop-worker.js?v=${window.DOCSEEKER_VERSION}`"),
  "app.js doit instancier crop-worker.js dynamiquement avec la version de l'application"
);
assert.ok(
  appJsContent.includes("reinitializeWorker()"),
  "OfflineCropRenderer dans app.js doit implémenter reinitializeWorker() pour le cycle de vie"
);
assert.ok(
  appJsContent.includes("navigator.serviceWorker.addEventListener(\"controllerchange\"") ||
  appJsContent.includes("navigator.serviceWorker.addEventListener('controllerchange'"),
  "app.js doit écouter l'événement controllerchange pour réinitialiser les workers à chaud"
);
console.log("✅ [3/5] app.js instancie ses Workers dynamiquement et écoute controllerchange.");

// 4. Vérifier frontend/download-queue-manager.js
const dqmPath = path.resolve(rootDir, "frontend/download-queue-manager.js");
const dqmContent = fs.readFileSync(dqmPath, "utf8");

assert.ok(
  dqmContent.includes("new Worker(`/offline-search-worker.js?v=${v}`"),
  "download-queue-manager.js doit instancier offline-search-worker.js avec la version dynamique"
);
assert.ok(
  dqmContent.includes("reinitializeWorker()"),
  "DownloadQueueManager doit implémenter reinitializeWorker()"
);
console.log("✅ [4/5] download-queue-manager.js synchronise dynamiquement offline-search-worker.js.");

// 5. Vérifier backend-rust/src/static_files.rs (En-tête no-cache sur sw.js)
const rustStaticPath = path.resolve(rootDir, "backend-rust/src/static_files.rs");
const rustStaticContent = fs.readFileSync(rustStaticPath, "utf8");

assert.ok(
  rustStaticContent.includes('path == "sw.js"') &&
  rustStaticContent.includes('"no-cache, no-store, must-revalidate"'),
  "backend-rust/src/static_files.rs doit interdire la mise en cache HTTP de sw.js pour garantir la détection immédiate des mises à jour"
);
console.log("✅ [5/5] Le backend Rust configure sw.js avec 'no-cache, no-store, must-revalidate'.");

console.log("\n🎉 TOUS LES CONTRÔLES DE CONSISTANCE DE VERSION ET CYCLE DE VIE ONT RÉUSSI !\n");
