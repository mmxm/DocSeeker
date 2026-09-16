/**
 * Limites et capacités d'exécution spécifiques à l'environnement client local (navigateur).
 * Toute la logique algorithmique est commune dans `search-core`, seules ces contraintes de concurrence matérielle diffèrent.
 */

// Nombre de tâches concurrentes de rendu PDF.js / OffscreenCanvas dans le navigateur client
// (Limité à 1 tâche séquentielle pour préserver la fluidité de l'interface et éviter les saturations mémoire sur mobile/tablette)
export const CLIENT_CONCURRENT_CROP_TASKS = 1;

// Nombre maximum de téléchargements de documents en parallèle dans la file d'attente
export const CLIENT_MAX_CONCURRENT_DOWNLOADS = 2;
