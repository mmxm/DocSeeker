import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

// Exposer globalement createMilkdown avec l'API Crepe officielle
window.createMilkdown = async function(rootElement, options = {}) {
  const { initialValue = '', onChange = () => {} } = options;

  // Créer l'instance Crepe officielle avec toutes ses fonctionnalités :
  // - Toolbar flottante (B, I, S, <>, ∑, 🔗)
  // - Slash commands '/' (titres, listes, code blocks, images, tables...)
  // - CodeMirror avec coloration syntaxique
  // - Support KaTeX mathématique
  // - Task lists interactives avec cases à cocher [-] et [x]
  // - Blocs images redimensionnables avec légendes
  // - Tableaux interactifs (ajout/suppression lignes et colonnes)
  const crepe = new Crepe({
    root: rootElement,
    defaultValue: initialValue || '',
  });

  // Branchement de l'écouteur de mise à jour Markdown
  crepe.on((listener) => {
    listener.markdownUpdated((ctx, markdown) => {
      onChange(markdown);
    });
  });

  await crepe.create();
  return crepe;
};
