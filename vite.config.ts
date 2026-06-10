import { defineConfig } from "vite";

export default defineConfig({
  // relative paths so the build also works from file:// inside Electron
  base: "./",
});
