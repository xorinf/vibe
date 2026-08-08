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
      // Default: `:3141` is the backend's own port (backend/.example.env
      // `APP_PORT`). The Functions emulator wraps the backend on `:4001`
      // per AGENTS.md but the local Firebase config
      // (backend/firebase.json) only declares the auth emulator —
      // override with VITE_API_PROXY=http://localhost:4001 when running
      // the Functions emulator for parity with the documented workflow.
      // Without this change, fresh dev setups hit ECONNREFUSED on
      // /api/interactive-experiences/:id/play because the proxy target
      // is empty.
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://localhost:3141',
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
