/**
 * The API bundle is a build artifact, not source.
 *
 * scripts/build-api-function.mjs writes apps/web/api-bundle/index.cjs before
 * the Next.js build. TypeScript checks the route before that file necessarily
 * exists (and it is git-ignored), so its shape is declared here instead —
 * without this, `next build` fails with "Cannot find module" on a clean
 * checkout even though the runtime import resolves correctly.
 */
declare module '@billing/api-bundle' {
  import type { IncomingMessage, ServerResponse } from 'node:http';
  const handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  export default handler;
}
