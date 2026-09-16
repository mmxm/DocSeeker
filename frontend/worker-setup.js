// worker-setup.js - Environnement universel pour Web Workers (PDF.js / Wasm)
if (typeof self !== 'undefined') {
  if (typeof window === 'undefined') {
    self.window = self;
  }
  if (typeof document === 'undefined') {
    const createDummyElement = () => ({
      append: () => {},
      remove: () => {},
      style: {},
      setAttribute: () => {},
      getElementsByTagName: () => [createDummyElement()],
      sheet: { insertRule: () => {}, cssRules: [] },
      getContext: (type) => {
        if (typeof OffscreenCanvas !== 'undefined') {
          return new OffscreenCanvas(1, 1).getContext(type);
        }
        return null;
      },
    });

    self.document = {
      createElement: (tag) => {
        if (tag === 'canvas' && typeof OffscreenCanvas !== 'undefined') {
          return new OffscreenCanvas(1, 1);
        }
        return createDummyElement();
      },
      createElementNS: () => createDummyElement(),
      documentElement: createDummyElement(),
      body: createDummyElement(),
      fonts: {
        add: () => {},
        delete: () => {},
        has: () => false,
      },
      baseURI: (self.location && self.location.href) ? self.location.href : '',
      URL: (self.location && self.location.href) ? self.location.href : '',
    };
  }
}
