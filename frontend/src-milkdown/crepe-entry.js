import { Crepe } from '@milkdown/crepe';
import { replaceAll } from '@milkdown/utils';
import { history } from '@milkdown/kit/plugin/history';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

import { shift, size } from '@floating-ui/dom';

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
    featureConfigs: {
      ...uploadConfig,
      [Crepe.Feature.BlockEdit]: {
        slashMenu: {
          offset: 8,
          middleware: [
            shift({
              padding: 12,
            }),
            size({
              padding: 12,
              apply({ availableHeight, elements }) {
                const maxH = Math.min(360, Math.max(160, availableHeight - 16));
                elements.floating.style.maxHeight = `${maxH}px`;
                const groups = elements.floating.querySelector('.menu-groups');
                if (groups) {
                  const tabGroup = elements.floating.querySelector('.tab-group');
                  const tabH = tabGroup ? tabGroup.offsetHeight : 54;
                  groups.style.maxHeight = `${Math.max(100, maxH - tabH)}px`;
                }
              },
            }),
          ],
        },
      },
    },
  });

  // Plugins Milkdown Kit : History (Undo/Redo) & Clipboard (Markdown Copy/Paste)
  crepe.editor.use(history).use(clipboard);

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
