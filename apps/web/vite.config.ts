import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "KajianQ",
        short_name: "KajianQ",
        description: "Islamic classical-knowledge chatbot on the DARS engine",
        theme_color: "#f6f0e3",
        background_color: "#f6f0e3",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,ico,woff2}"],
        // The SPA fallback is what makes every client route — /about and
        // /collection included — open offline after precache: a navigation
        // request is answered with the precached index.html and the router
        // resolves the path client-side. Declared explicitly (it is also
        // workbox's generateSW default) so the contract sits next to the
        // routes it serves, not hidden in plugin defaults.
        navigateFallback: "index.html",
      },
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/v1": "http://127.0.0.1:8787",
    },
  },
});
