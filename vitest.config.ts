import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    // Web tests set their own DOM environment with a `@vitest-environment jsdom` comment.
    include: ["test/**/*.test.ts", "web/src/**/*.test.tsx"],
  },
});
