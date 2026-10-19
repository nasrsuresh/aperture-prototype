// Jest transformer backed by esbuild (already a dependency for the Lambda
// bundles). Avoids a native swc/ts-jest binding.
const esbuild = require('esbuild');

module.exports = {
  process(src, filename) {
    const result = esbuild.transformSync(src, {
      loader: 'ts',
      format: 'cjs',
      target: 'node20',
      sourcemap: 'inline',
      sourcefile: filename,
    });
    return { code: result.code };
  },
};
