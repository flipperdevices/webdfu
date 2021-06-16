import ts from "rollup-plugin-ts";
import { terser } from "rollup-plugin-terser";

export default {
  input: "./index.ts",
  output: {
    file: "./dist/index.js",
    format: "cjs",
  },
  plugins: [ts({}), terser({})],
};
