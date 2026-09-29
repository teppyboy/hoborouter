import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    ignorePatterns: ["deploy/cpa/config.example.yaml"], // verbatim pinned upstream snapshot — must not be reformatted
    plugins: ["react", "typescript", "oxc"],
    rules: {
      "react/rules-of-hooks": "error",
      "react/only-export-components": ["warn", { allowConstantExport: true }],
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
