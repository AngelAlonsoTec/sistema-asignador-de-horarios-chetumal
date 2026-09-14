import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
    plugins: [vue()],
    server: {
        port: 5173,
        // En desarrollo el backend corre aparte. El proxy hace que las
        // peticiones salgan al mismo origen, igual que en producción detrás de
        // nginx, así que el código de `api.js` no necesita saber dónde corre.
        proxy: {
            "/api": {
                target: process.env.BACKEND_URL ?? "http://localhost:4000",
                changeOrigin: true
            }
        }
    },
    // Las pruebas de dominio corren con el corredor de Node, sin dependencias.
    // Los componentes necesitan un DOM, y eso es lo que trae vitest + happy-dom.
    test: {
        environment: "happy-dom",
        include: ["test/**/*.spec.js"]
    },
    build: {
        outDir: "dist",
        sourcemap: true
    }
});
