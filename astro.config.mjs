import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://mothersgoldspice.com",
  vite: {
    plugins: [tailwindcss()],
  },
});
