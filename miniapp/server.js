import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const host = process.env.MINIAPP_HOST ?? "127.0.0.1";
const port = process.env.MINIAPP_PORT ? Number(process.env.MINIAPP_PORT) : 17893;
const root = resolve(import.meta.dirname, "src");
const vendorFiles = new Map([
  ["/vendor/marked.esm.js", resolve(import.meta.dirname, "node_modules/marked/lib/marked.esm.js")],
  ["/vendor/purify.es.mjs", resolve(import.meta.dirname, "node_modules/dompurify/dist/purify.es.mjs")],
]);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const vendorPath = vendorFiles.get(path);
    if (vendorPath) {
      const body = await readFile(vendorPath);
      response.writeHead(200, {
        "Content-Type": contentTypes[extname(vendorPath)] ?? "text/javascript; charset=utf-8",
      });
      response.end(body);
      return;
    }

    const filePath = resolve(join(root, decodeURIComponent(path)));

    if (filePath !== root && !filePath.startsWith(`${root}\\`) && !filePath.startsWith(`${root}/`)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
}).listen(port, host, () => {
  console.log(`Miniapp page listening on http://${host}:${port}`);
});
