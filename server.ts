import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Dedicated local-showcase port — keep away from the normal app on :3000
const PORT = Number(process.env.PORT) || 5180;
const HOST = '0.0.0.0';
// 8765 is often used by Nvidia_test_zarr_format/viewer — default aside for this app
const configuredZarrApiPort = Number(process.env.ZARR_API_PORT) || 8766;
let zarrApiPort = configuredZarrApiPort;
const zarrApiOrigin = () => `http://127.0.0.1:${zarrApiPort}`;

let zarrChild: ChildProcess | null = null;

function probeZarrApi(port: number, requireHistoryApi = false): Promise<boolean> {
  return new Promise((resolve) => {
    const probePath = requireHistoryApi ? '/api/history/status' : '/api/health';
    const req = http.get(`http://127.0.0.1:${port}${probePath}`, (res) => {
      if (!requireHistoryApi) {
        res.resume();
        resolve((res.statusCode || 500) < 500);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }
        try {
          const status = JSON.parse(body) as { storage_format?: string };
          resolve(status.storage_format === 'historical-events-zarr-v1');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(startPort, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine an available local API port.'));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startZarrSidecar() {
  if (await probeZarrApi(zarrApiPort, true)) {
    console.log(`[zarr-api] Compatible API already running at ${zarrApiOrigin()}`);
    return;
  }
  if (await probeZarrApi(zarrApiPort)) {
    const oldPort = zarrApiPort;
    zarrApiPort = await findAvailablePort(oldPort + 1);
    console.warn(
      `[zarr-api] API on :${oldPort} is outdated; starting the historical replay API on :${zarrApiPort}`
    );
  }
  const script = path.resolve(__dirname, 'backend', 'zarr_field_server.py');
  const venvPython = process.platform === 'win32'
    ? path.resolve(__dirname, '.venv', 'Scripts', 'python.exe')
    : path.resolve(__dirname, '.venv', 'bin', 'python');
  const condaPython = process.env.CONDA_PREFIX
    ? path.resolve(
        process.env.CONDA_PREFIX,
        process.platform === 'win32' ? 'python.exe' : 'bin/python'
      )
    : '';
  const projectCondaPython = process.platform === 'win32' && process.env.USERPROFILE
    ? path.resolve(process.env.USERPROFILE, 'miniconda3', 'envs', 'weatherAI_env', 'python.exe')
    : '';
  const py = process.env.PYTHON
    || (existsSync(venvPython) ? venvPython : '')
    || (condaPython && existsSync(condaPython) ? condaPython : '')
    || (projectCondaPython && existsSync(projectCondaPython) ? projectCondaPython : '')
    || 'python';
  console.log(`[zarr-api] Starting ${py} ${script} on :${zarrApiPort}`);
  zarrChild = spawn(py, [script], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ZARR_API_PORT: String(zarrApiPort) },
  });
  zarrChild.stdout?.on('data', (buf) => {
    process.stdout.write(`[zarr-api] ${buf}`);
  });
  zarrChild.stderr?.on('data', (buf) => {
    process.stderr.write(`[zarr-api] ${buf}`);
  });
  zarrChild.on('exit', (code, signal) => {
    console.warn(`[zarr-api] exited code=${code} signal=${signal}`);
    zarrChild = null;
  });
  zarrChild.on('error', (error) => {
    console.error(`[zarr-api] failed to start ${py}: ${error.message}`);
    zarrChild = null;
  });
}

function proxyToZarr(req: express.Request, res: express.Response) {
  // Use originalUrl so this works whether or not Express has stripped the mount path.
  const original = req.originalUrl || req.url || '/api/zarr';
  const suffix = original.replace(/^\/api\/zarr/, '') || '/';
  const targetPath = `/api${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
  const opts: http.RequestOptions = {
    hostname: '127.0.0.1',
    port: zarrApiPort,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${zarrApiPort}` },
  };

  const upstream = http.request(opts, (up) => {
    res.status(up.statusCode || 502);
    for (const [k, v] of Object.entries(up.headers)) {
      if (v != null) res.setHeader(k, v);
    }
    up.pipe(res);
  });
  upstream.on('error', (err) => {
    res.status(503).json({
      error: 'Zarr field API unavailable',
      detail: String(err.message || err),
      hint: `Start backend/zarr_field_server.py on port ${zarrApiPort}; check Python and backend dependencies.`,
    });
  });
  req.pipe(upstream);
}

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  // Proxy before Vite so /api/zarr/* never falls through to the SPA
  app.use('/api/zarr', proxyToZarr);

  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: {
        middlewareMode: true,
        host: HOST,
        port: PORT,
        watch: {
          ignored: ['**/forecast.zarr/**', '**/*.zarr/**'],
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  if (process.env.SKIP_ZARR_SIDECAR !== '1') {
    await startZarrSidecar();
  }

  const httpServer = app.listen(PORT, HOST, () => {
    console.log(`[LOCAL showcase] Open http://localhost:${PORT}  (normal app stays on :3000)`);
    console.log(`[LOCAL showcase] Zarr API proxied at /api/zarr/* → ${zarrApiOrigin()}`);
  });
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[Server] Failed to listen on ${PORT}: ${err.message}`);
    process.exit(1);
  });
}

const shutdown = () => {
  if (zarrChild && !zarrChild.killed) {
    zarrChild.kill();
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer().catch((err) => {
  console.error('[Server Error]', err);
});
