import ts from "rollup-plugin-ts";
import { terser } from "rollup-plugin-terser";

export default {
  input: "./index.ts",
  output: [
    {
      file: "./dist/index.cjs",
      format: "cjs",
    },
    {
      file: "./dist/index.js",
      format: "es",
    },
  ],
  plugins: [ts({}), terser({})],
};
