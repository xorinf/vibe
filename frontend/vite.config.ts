import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { comlink } from "vite-plugin-comlink";

// https://vitejs.dev/config/
export default defineConfig({
  worker: {
    format: 'es',
    plugins: () => [comlink()],
    rollupOptions: {
      output: {
        entryFileNames: 'worker/[name]-[hash].js',
        chunkFileNames: 'worker/[name]-[hash].js',
        assetFileNames: 'worker/[name]-[hash][ext]',
      },
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      // Proxy API requests to the local backend.
      // Default: `:8080` matches the locally-running `node build/index.js`
      // backend (the build output of `pnpm --filter backend build`).
      // Other documented setups:
      //   - `pnpm --filter backend dev` runs on `:3141` (backend/.example.env
      //     `APP_PORT`) — override with VITE_API_PROXY=http://localhost:3141
      //   - Firebase Functions emulator wraps the backend on `:4001` (per
      //     AGENTS.md) — override with VITE_API_PROXY=http://localhost:4001
      // Without this change, the Vite proxy on its old hardcoded `:4001`
      // (or the just-shipped `:3141`) hits ECONNREFUSED for the common
      // local-build workflow, and the student ILE page sees
      // `loading: true` forever because /play never returns.
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://localhost:8080',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
});
