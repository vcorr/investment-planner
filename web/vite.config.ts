import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webDir = fileURLToPath(new URL(".", import.meta.url));
const repoDir = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root: webDir,
  envDir: webDir,
  plugins: [react()],
  // The page imports the shared settings schema from supabase/functions/_shared/.
  server: { port: 5173, strictPort: true, fs: { allow: [repoDir] } },
  build: { outDir: "dist", emptyOutDir: true },
});
