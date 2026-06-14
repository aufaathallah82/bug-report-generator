import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const classicContentScriptPattern = /(^|\n)\s*(?:import(?:[\s{*]|["'])|export(?:[\s{*]))|import\.meta|\bimport\s*\(/;

function assertClassicContentScript() {
  return {
    name: 'assert-classic-content-script',
    generateBundle(_options, bundle) {
      const contentScript = bundle['contentScript.js'];

      if (!contentScript || contentScript.type !== 'chunk') {
        this.error('dist/contentScript.js was not emitted as a bundled entry.');
        return;
      }

      if (contentScript.imports.length > 0 || classicContentScriptPattern.test(contentScript.code)) {
        this.error('contentScript.js must be a standalone classic script with no import/export syntax.');
      }
    },
  };
}

export default defineConfig({
  plugins: [assertClassicContentScript()],
  build: {
    emptyOutDir: true,
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        background: resolve(__dirname, 'src/background.ts'),
        contentScript: resolve(__dirname, 'src/contentScript.ts'),
        pageLogger: resolve(__dirname, 'src/pageLogger.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
