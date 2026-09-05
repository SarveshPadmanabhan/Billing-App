import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Adapt a Web `Request` to the Node req/res pair Express expects.
 *
 * The App Router speaks Web Fetch objects; the bundled NestJS app is an
 * Express handler expecting Node's IncomingMessage/ServerResponse. This
 * bridges the two without pulling in a framework adapter.
 *
 * Bodies are buffered rather than streamed: every endpoint here is JSON
 * capped at 1mb by express.json(), and buffering keeps the shim small enough
 * to reason about. Responses are collected and returned as one Response,
 * which is also what a serverless function does anyway.
 */

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

export async function toWebResponse(
  handler: NodeHandler,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const bodyBuffer = ['GET', 'HEAD'].includes(request.method)
    ? Buffer.alloc(0)
    : Buffer.from(await request.arrayBuffer());

  // A readable stream carrying the body, dressed up as an IncomingMessage.
  const req = Readable.from(bodyBuffer.length ? [bodyBuffer] : []) as unknown as IncomingMessage;
  req.method = request.method;
  // Express routes on `url`, which must be the path + query, not the origin.
  req.url = `${url.pathname}${url.search}`;
  req.headers = Object.fromEntries(request.headers.entries());
  // Behind Vercel's proxy this is the client address Express reads for req.ip,
  // which the audit log records.
  (req as unknown as { socket: unknown }).socket = {
    remoteAddress: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
  };

  return new Promise<Response>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const headers = new Headers();
    let statusCode = 200;

    const res = {
      statusCode: 200,
      // Express and Nest both write headers through these.
      setHeader(name: string, value: number | string | string[]) {
        // set-cookie is the one header that legitimately repeats; Headers
        // must append it or only the last cookie survives — which would drop
        // the session cookie whenever auth sets more than one.
        if (Array.isArray(value)) {
          for (const v of value) headers.append(name, String(v));
        } else {
          headers.set(name, String(value));
        }
        return res;
      },
      getHeader: (name: string) => headers.get(name) ?? undefined,
      getHeaders: () => Object.fromEntries(headers.entries()),
      removeHeader: (name: string) => headers.delete(name),
      writeHead(code: number, maybeHeaders?: Record<string, number | string | string[]>) {
        statusCode = code;
        if (maybeHeaders) {
          for (const [k, v] of Object.entries(maybeHeaders)) res.setHeader(k, v);
        }
        return res;
      },
      write(chunk: string | Buffer) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return true;
      },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve(
          new Response(chunks.length ? Buffer.concat(chunks) : null, {
            // res.statusCode is what Express sets directly (res.status(404));
            // writeHead callers set `statusCode` above. Prefer whichever moved.
            status: res.statusCode !== 200 ? res.statusCode : statusCode,
            headers,
          }),
        );
        return res;
      },
      on: () => res,
      once: () => res,
      emit: () => false,
      headersSent: false,
    };

    try {
      handler(req, res as unknown as ServerResponse);
    } catch (error) {
      reject(error);
    }
  });
}
