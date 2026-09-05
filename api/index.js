/**
 * Vercel function entrypoint.
 *
 * Deliberately plain JavaScript and deliberately trivial: it re-exports a
 * bundle that `scripts/build-api-function.mjs` produced during the build.
 *
 * Vercel bundles whatever this file imports. Pointing it at the TypeScript
 * sources meant Vercel had to resolve the pnpm workspace packages (which ship
 * as .ts with NodeNext specifiers) and every optional require() inside NestJS
 * — @nestjs/microservices, @nestjs/websockets, class-validator — and it fails
 * the whole function when any of them is missing. Bundling ahead of time with
 * our own esbuild config is where those externals can be declared correctly.
 *
 * _bundle.cjs is a build artifact and is git-ignored; it must exist before
 * the function is packaged, which the root build script guarantees.
 */
module.exports = require('./_bundle.cjs');
