import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  // Bundle workspace packages into the output so Vercel/Node.js
  // doesn't need to resolve them from source .ts files at runtime
  noExternal: [/@trade-bot\/.*/],
});
