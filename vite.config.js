import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages serves it under /isoride/).
  base: "./",
  // MapLibre alone is ~800 kB; it is loaded once and cached.
  build: { chunkSizeWarningLimit: 1000 },
});
