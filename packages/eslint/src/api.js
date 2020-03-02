'use strict';

const fs = require('fs');
const path = require('path');
const glob = require('glob-cache');
const arrayify = require('arrify');
const memoizeFs = require('memoize-fs');
const serialize = require('serialize-javascript');
const { CLIEngine, Linter } = require('eslint');

// const foo = 2;

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/bower_components/**',
  'flow-typed/**',
  'coverage/**',
  '**/*fixture*/**',
  '{tmp,temp}/**',
  '**/*.min.js',
  '**/bundle.js',
  'vendor/**',
  'dist/**',
];

const DEFAULT_INPUTS = ['**/src/**', '**/*test*/**'];
const DEFAULT_EXTENSIONS = ['js', 'jsx', 'cjs', 'mjs', 'ts', 'tsx'];
const DEFAULT_OPTIONS = {
  exit: true,
  warnings: false,
  reporter: 'codeframe',
  input: DEFAULT_INPUTS,
  ignore: DEFAULT_IGNORE,
  extensions: DEFAULT_EXTENSIONS,
  reportUnusedDisableDirectives: true,
};

function normalizeOptions(options) {
  const forcedOptions = {
    fix: true,
    baseConfig: {
      extends: [
        '@tunnckocore/eslint-config',
        '@tunnckocore/eslint-config/mdx',
        '@tunnckocore/eslint-config/jest',
        '@tunnckocore/eslint-config/node',
        '@tunnckocore/eslint-config/promise',
        '@tunnckocore/eslint-config/unicorn',
      ],
    },
    useEslintrc: false,
    cache: true,
    cacheLocation: './.eslintcache',
  };
  const opts = { ...DEFAULT_OPTIONS, ...options, ...forcedOptions };

  opts.input = arrayify(opts.input);
  opts.ignore = DEFAULT_IGNORE.concat(arrayify(opts.ignore));
  opts.extensions = arrayify(opts.extensions);

  return opts;
}

/**
  Using CLIEngine executeOnFiles

  1. Has 6 huge (1000 lines) files
    - eslint 13 files (fresh, no cache) ~6.16s
    - eslint 13 files (warm cache) ~2.75s
  2. Each file has around ~200 lines
    - eslint 5 files (fresh, no cache) ~3.07s
    - eslint 5 files (warm cache) ~2.56s
 */

/**
  Using `linter.verify` API
  and aggressive caching & memoization

  1. Has 5 huge (1000 lines) files
    - @hela/eslint 13 files (fresh, no cache) - 3.72s
    - @hela/eslint 13 files (warm cache) - 0.6s
 */
function lint(name) {
  return async (value, fp, options) => {
    if (name === 'files') {
      // eslint-disable-next-line no-param-reassign
      options = fp;
    }
    const opts = normalizeOptions(options);

    const engine = new CLIEngine(opts);
    const fn = name === 'files' ? engine.executeOnFiles : engine.executeOnText;
    const report = fn.apply(
      engine,
      [value, name === 'text' && fp].filter(Boolean),
    );

    report.format = engine.getFormatter(opts.reporter);

    if (name === 'files') {
      CLIEngine.outputFixes(report);
    }

    return report;
  };
}

async function lintText(code, fp, options) {
  return lint('text')(code, fp, options);
}

async function lintFiles(code, fp, options) {
  return lint('files')(code, fp, options);
}

async function smartLintFiles(patterns, options) {
  const memoizer = memoizeFs({
    cachePath: path.join(process.cwd(), '.cache', 'verify-process'),
  });

  const opts = normalizeOptions(options);
  const linter = new Linter();
  const engine = new CLIEngine();

  const report = {
    results: [],
    errorCount: 0,
    warningCount: 0,
    fixableErrorCount: 0,
    fixableWarningCount: 0,
  };

  const eslintConfig = {};

  await glob({
    include: patterns,
    exclude: opts.ignore,
    globOptions: opts.globOptions,
    always: true,

    async hook({ valid, missing, file, cacheFile, cacheLocation, cacache }) {
      // if (valid === false || (valid && missing)) {

      const meta = cacheFile && cacheFile.metadata;
      // const config = meta
      //   ? meta.eslintConfig
      //   : engine.getConfigForFile(file.path);

      const dirname = path.dirname(file.path);
      let config = null;
      if (eslintConfig[dirname]) {
        // console.log('using config for', dirname);
        config = eslintConfig[dirname];
      } else {
        // console.log('new config');
        config = meta ? meta.eslintConfig : engine.getConfigForFile(file.path);
        eslintConfig[dirname] = config;
      }

      if (valid === false || (valid && missing)) {
        config.plugins.forEach((pluginName) => {
          let plugin = null;

          if (pluginName.startsWith('@')) {
            // eslint-disable-next-line import/no-dynamic-require, global-require
            plugin = require(pluginName);
          } else {
            // eslint-disable-next-line import/no-dynamic-require, global-require
            plugin = require(`eslint-plugin-${pluginName}`);
          }

          Object.keys(plugin.rules).forEach((ruleName) => {
            linter.defineRule(
              `${pluginName}/${ruleName}`,
              plugin.rules[ruleName],
            );
          });
        });
      }

      const contents = file.contents.toString();
      const memoizedFunc = await memoizer.fn((cont, cfg) =>
        // console.log('content changed! ... verify called');

        linter.verifyAndFix(cont, cfg),
      );
      const { output, messages } = await memoizedFunc(contents, config);

      const result = {
        filePath: file.path,
        messages,
        errorCount: []
          .concat(messages)
          .filter(Boolean)
          .filter((x) => x.severity === 2)
          .reduce((acc) => {
            report.errorCount += 1;

            return acc + 1;
          }, 0),
        warningCount: []
          .concat(messages)
          .filter(Boolean)
          .filter((x) => x.severity === 1)
          .reduce((acc) => {
            report.warningCount += 1;

            return acc + 1;
          }, 0),
        fixableErrorCount: 0,
        fixableWarningCount: 0,
      };

      if (JSON.stringify(result) !== JSON.stringify(meta && meta.report)) {
        // console.log('report changed! re-add / store to cache');

        cacache.put(cacheLocation, file.path, output, {
          metadata: {
            contents,
            output,
            report: result,
            eslintConfig: config,
          },
        });
      }

      fs.writeFileSync(file.path, output);
      report.results.push({ ...result, source: output });
    },
  });

  return report;
}

exports.normalizeOptions = normalizeOptions;
exports.lint = lint;
exports.lintText = lintText;
exports.lintFiles = lintFiles;
exports.smartLintFiles = smartLintFiles;
exports.DEFAULT_IGNORE = DEFAULT_IGNORE;
exports.DEFAULT_INPUTS = DEFAULT_INPUTS;
exports.DEFAULT_INPUT = DEFAULT_INPUTS;