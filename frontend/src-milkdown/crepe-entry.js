import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/utils';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

// Exposer globalement createMilkdown avec l'API Crepe officielle
window.createMilkdown = async function(rootElement, options = {}) {
  const { initialValue = '', onChange = () => {}, onUploadAsset = null } = options;

  // Hook d'upload des images : sans lui, le bloc image de Crepe insère une URL
  // blob: locale (non persistée) au collage/dépôt de fichier, ce qui produisait
  // des images mortes après rechargement et des doublons avec l'upload assets/.
  // onUploadAsset retourne l'URL finale du fichier dans assets/<stem>/.
  const uploadConfig = onUploadAsset
    ? {
        imageBlock: { onUpload: onUploadAsset },
        image: { onUpload: onUploadAsset },
      }
    : {};

  const crepe = new Crepe({
    root: rootElement,
    defaultValue: initialValue || '',
    featureConfigs: uploadConfig,
  });

  // Branchement de l'écouteur de mise à jour Markdown
  crepe.on((listener) => {
    listener.markdownUpdated((ctx, markdown) => {
      onChange(markdown);
    });
  });

  await crepe.create();

  // Méthode pour remplacer le contenu Markdown depuis le panneau brut
  crepe.setMarkdown = function(md) {
    try {
      crepe.editor.action(replaceAll(md));
    } catch (e) {
      console.warn('[Milkdown] Error setting markdown:', e);
    }
  };

  return crepe;
};
