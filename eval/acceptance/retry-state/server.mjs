import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
const baseURL = new URL(process.env.WORKFLOW_BASE_URL || 'http://127.0.0.1:3117')
const root = process.cwd()
const files = new Map([['/', ['index.html', 'text/html']], ['/src/app.js', ['src/app.js', 'text/javascript']], ['/src/request.mjs', ['src/request.mjs', 'text/javascript']]])
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, baseURL)
    if (url.pathname === '/api/profile') {
      if (process.env.WORKFLOW_ENVIRONMENT_ID !== 'live') { res.writeHead(503); res.end('Backend has not been deployed'); return }
      if (req.method !== 'GET' || url.search) { res.writeHead(400); res.end('Wrong contract'); return }
      res.writeHead(200, { 'content-type': 'application/json', 'x-demo-backend': 'local-service-v1' })
      res.end(await readFile(path.join(root, 'backend-response.json')))
      return
    }
    const file = files.get(url.pathname)
    if (!file) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' })
    res.end(await readFile(path.join(root, file[0])))
  } catch { res.writeHead(500); res.end('Fixture server error') }
})
server.listen(Number(baseURL.port), baseURL.hostname, () => console.log(`Demo ready at ${baseURL.origin}`))
