/// Limites et capacités d'exécution spécifiques à l'environnement serveur distant.
/// Toute la logique algorithmique est commune dans `search-core`, seules ces contraintes de concurrence matérielle diffèrent.

/// Nombre de tâches concurrentes de rendu Pdfium autorisées sur le serveur (dimensionné pour le CPU / threads du serveur)
pub const SERVER_CONCURRENT_CROP_TASKS: usize = 2;

/// Taille maximale du cache LRU d'images rendu serveur
pub const SERVER_PAGE_CACHE_SIZE: usize = 8;
