import { defineConfig } from 'vite';

// relative base so the built folder works when Wallpaper Engine opens index.html from disk
export default defineConfig({
  base: './',
  // the pipeline builds other scenes into their own folders: WALLPAPER_PUBLIC = assets dir, WALLPAPER_DIST = output
  publicDir: process.env.WALLPAPER_PUBLIC || 'public',
  build: {
    target: 'es2022',
    outDir: process.env.WALLPAPER_DIST || 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5199, strictPort: true },
});
