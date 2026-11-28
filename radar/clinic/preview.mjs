// Local preview of radar.bookease.co/clinic/: serves radar/ and answers /clinic/api/clinic/view + img from a folder of
// saved jobs (<dir>/<id>/view.json + *.jpg). Usage: node radar/clinic/preview.mjs <jobs-dir> [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const site = path.join(here, '..');
const jobs = process.argv[2];
const port = Number(process.argv[3] || 8791);
const type = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (file, t) => fs.readFile(file, (e, b) => { if (e) { res.writeHead(404); res.end('not found'); return; } res.writeHead(200, { 'Content-Type': t }); res.end(b); });
  const id = (u.searchParams.get('id') || '').replace(/[^0-9a-f]/g, '');
  if (u.pathname.endsWith('/api/clinic/view')) return send(path.join(jobs, id, 'view.json'), 'application/json');
  if (u.pathname.endsWith('/api/clinic/img')) return send(path.join(jobs, id, (u.searchParams.get('n') || '').replace(/[^a-z.]/g, '')), 'image/jpeg');
  let f = path.join(site, path.normalize(u.pathname).replace(/^\/+/, ''));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (f.startsWith(site) && fs.existsSync(f) && fs.statSync(f).isFile()) return send(f, type[path.extname(f)] || 'application/octet-stream');
  res.writeHead(404); res.end('not found');
}).listen(port, () => console.log(`clinic radar preview http://localhost:${port}`));
