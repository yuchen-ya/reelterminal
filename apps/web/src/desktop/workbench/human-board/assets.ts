// Set before Excalidraw evaluates its font registry.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = new URL("excalidraw-assets/", document.baseURI).href;
