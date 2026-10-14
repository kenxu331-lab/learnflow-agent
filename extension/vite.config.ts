import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        matureExtractor: resolve(__dirname, "src/capture/mature-extractor.ts"),
        shadowMermaidHook: resolve(__dirname, "src/capture/shadow-mermaid-hook.ts"),
        sidepanel: resolve(__dirname, "sidepanel.html"),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "background.js";
          if (chunk.name === "matureExtractor") return "assets/mature-extractor.js";
          if (chunk.name === "shadowMermaidHook") return "assets/shadow-mermaid-hook.js";
          return "assets/[name].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
