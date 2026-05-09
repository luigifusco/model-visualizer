import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';
import puppeteer from 'puppeteer-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 8080);
const basePath = normalizeBasePath(process.env.BASE_PATH || '');
const publicBaseUrl = normalizePublicBaseUrl(
  process.env.PUBLIC_BASE_URL || `http://localhost:${port}${basePath}`,
);
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const uploadTmpDir = path.join(uploadDir, '.tmp');
const renderCacheDir = path.join(uploadDir, 'renders');
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const maxUploadFiles = Number(process.env.MAX_UPLOAD_FILES || 20);
const uploadTimeoutMs = Number(process.env.UPLOAD_TIMEOUT_MS || 30 * 60 * 1000);
const tempUploadMaxAgeMs = Number(process.env.TEMP_UPLOAD_MAX_AGE_MS || 24 * 60 * 60 * 1000);
const renderWidth = Number(process.env.RENDER_WIDTH || 1280);
const renderHeight = Number(process.env.RENDER_HEIGHT || 900);
const renderTimeoutMs = Number(process.env.RENDER_TIMEOUT_MS || 10 * 1000);
const renderSessionTtlMs = Number(process.env.RENDER_SESSION_TTL_MS || 60 * 1000);
const isProduction = process.env.NODE_ENV === 'production';
const renderJobs = new Map();
const renderSessions = new Map();
const allowedUploadExtensions = new Set([
  '.obj',
  '.mtl',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
]);

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(uploadTmpDir, { recursive: true });
fs.mkdirSync(renderCacheDir, { recursive: true });
cleanupStaleTempUploads();
setInterval(cleanupStaleTempUploads, 60 * 60 * 1000).unref();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadTmpDir),
    filename: (_req, file, callback) => {
      const id = crypto.randomUUID();
      callback(null, `${id}${path.extname(file.originalname).toLowerCase()}.upload`);
    },
  }),
  limits: {
    fileSize: maxUploadBytes,
    files: maxUploadFiles,
  },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!allowedUploadExtensions.has(extension)) {
      const error = new Error('Upload an .obj file with optional .mtl and image texture files.');
      error.code = 'UNSUPPORTED_FILE_TYPE';
      callback(error);
      return;
    }

    callback(null, true);
  },
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
});
app.use(express.json());

const api = express.Router();

api.get('/config', (_req, res) => {
  res.json({
    basePath,
    maxUploadBytes,
    maxUploadFiles,
    renderWidth,
    renderHeight,
    renderSessionTtlMs,
  });
});

api.post('/models', upload.any(), (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    sendUploadError(req, res, {
      status: 400,
      code: 'NO_FILES',
      message: 'Upload one .obj file, optionally with its .mtl and texture files.',
      receivedFiles: [],
    });
    return;
  }

  const objFiles = files.filter((file) => path.extname(file.originalname).toLowerCase() === '.obj');
  if (objFiles.length !== 1) {
    cleanupTempFiles(files);
    sendUploadError(req, res, {
      status: 400,
      code: 'INVALID_OBJ_COUNT',
      message: 'Upload exactly one .obj file.',
      receivedFiles: getUploadDebugFiles(files),
      objFileCount: objFiles.length,
    });
    return;
  }

  const id = crypto.randomUUID();
  const finalDir = path.join(uploadDir, id);
  const storedFileNames = new Set();

  try {
    fs.mkdirSync(finalDir);

    for (const file of files) {
      const storedName = file === objFiles[0] ? 'model.obj' : getSafeOriginalFileName(file.originalname);
      const normalizedName = storedName.toLowerCase();

      if (storedFileNames.has(normalizedName)) {
        throw new Error(`Duplicate uploaded filename: ${storedName}`);
      }

      storedFileNames.add(normalizedName);
      fs.renameSync(file.path, path.join(finalDir, storedName));
    }
  } catch (error) {
    cleanupTempFiles(files);
    fs.rmSync(finalDir, { recursive: true, force: true });
    sendUploadError(req, res, {
      status: 400,
      code: 'STORE_FAILED',
      message: error.message || 'Upload failed.',
      receivedFiles: getUploadDebugFiles(files),
    });
    return;
  }

  res.status(201).json({
    id,
    url: `${publicBaseUrl}/models/${id}`,
  });
});

api.get('/models/:id/manifest', (req, res) => {
  const id = req.params.id;
  if (!isValidModelId(id)) {
    res.status(400).json({ error: 'Invalid model id.' });
    return;
  }

  const modelPath = getModelFilePath(id);
  if (!modelPath) {
    res.status(404).json({ error: 'Model not found.' });
    return;
  }

  const assetNames = getAssetNames(id);
  const materialNames = assetNames.filter((name) => path.extname(name).toLowerCase() === '.mtl');
  const referencedMaterials = getReferencedMaterialNames(modelPath);
  res.json({
    id,
    objUrl: `${basePath}/api/models/${id}/file`,
    materials: materialNames.map((name) => ({
        name,
        url: `${basePath}/api/models/${id}/assets/${encodeURIComponent(name)}`,
      })),
    missingMaterials: referencedMaterials.filter(
      (name) => !materialNames.some((assetName) => assetName.toLowerCase() === name.toLowerCase()),
    ),
  });
});

api.get('/models/:id/file', (req, res) => {
  const id = req.params.id;
  if (!isValidModelId(id)) {
    res.status(400).json({ error: 'Invalid model id.' });
    return;
  }

  const modelPath = getModelFilePath(id);
  if (!modelPath) {
    res.status(404).json({ error: 'Model not found.' });
    return;
  }

  res.type('text/plain').sendFile(modelPath);
});

api.get('/models/:id/render.png', async (req, res, next) => {
  const id = req.params.id;
  if (!isValidModelId(id)) {
    res.status(400).json({ error: 'Invalid model id.' });
    return;
  }

  const modelPath = getModelFilePath(id);
  if (!modelPath) {
    res.status(404).json({ error: 'Model not found.' });
    return;
  }

  try {
    const cameraState = parseRenderCameraQuery(req.query);
    if (cameraState) {
      const buffer = await renderModelImageBuffer(id, modelPath, cameraState);
      res.setHeader('Cache-Control', 'no-store');
      res.type('png').send(buffer);
      return;
    }

    const renderPath = await ensureModelRender(id, modelPath, req.query.refresh === '1');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('png').sendFile(renderPath);
  } catch (error) {
    next(error);
  }
});

api.get('/models/:id/assets/:filename', (req, res) => {
  const id = req.params.id;
  const filename = req.params.filename;
  if (!isValidModelId(id) || !isSafeFileName(filename)) {
    res.status(400).json({ error: 'Invalid asset path.' });
    return;
  }

  const assetPath = path.join(uploadDir, id, filename);
  if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    res.status(404).json({ error: 'Asset not found.' });
    return;
  }

  res.sendFile(assetPath);
});

app.use(joinRoute(basePath, '/api'), api);

if (isProduction) {
  const distDir = path.join(__dirname, 'dist');
  app.use(basePath || '/', express.static(distDir));
  app.get(joinRoute(basePath, '/*splat'), (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
} else {
  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
}

app.use((err, req, res, next) => {
  if (!(err instanceof multer.MulterError) && !isUploadRequest(req)) {
    next(err);
    return;
  }

  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    sendUploadError(req, res, {
      status: 413,
      code: err.code,
      message: `A file is too large. Limit is ${formatBytes(maxUploadBytes)} per file.`,
      field: err.field,
    });
    return;
  }

  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_COUNT') {
    sendUploadError(req, res, {
      status: 413,
      code: err.code,
      message: `Too many files. Limit is ${maxUploadFiles} files per upload.`,
      field: err.field,
    });
    return;
  }

  sendUploadError(req, res, {
    status: 400,
    code: err.code || 'UPLOAD_FAILED',
    message: err.message || 'Upload failed.',
    field: err.field,
  });
});

app.use((err, req, res, _next) => {
  const status = err.statusCode || 500;
  const debug = {
    requestId: req.requestId,
    code: err.code || 'SERVER_ERROR',
    status,
  };

  console.error('model-visualizer request failed', {
    ...debug,
    message: err.message,
  });

  res.status(status).json({
    error: err.message || 'Request failed.',
    debug,
  });
});

const server = app.listen(port, () => {
  console.log(
    `model-visualizer listening on port ${port} at base path "${basePath || '/'}" with ${formatDuration(uploadTimeoutMs)} upload timeout`,
  );
});

server.requestTimeout = uploadTimeoutMs;
server.headersTimeout = Math.min(120 * 1000, uploadTimeoutMs);
server.keepAliveTimeout = 65 * 1000;

function normalizeBasePath(value) {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

function normalizePublicBaseUrl(value) {
  return value.trim().replace(/\/+$/g, '');
}

function joinRoute(prefix, route) {
  const normalizedRoute = route.startsWith('/') ? route : `/${route}`;
  return `${prefix}${normalizedRoute}` || '/';
}

function isUploadRequest(req) {
  return req.method === 'POST' && req.path === joinRoute(basePath, '/api/models');
}

function isValidModelId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function getModelFilePath(id) {
  const directoryModelPath = path.join(uploadDir, id, 'model.obj');
  if (fs.existsSync(directoryModelPath)) {
    return directoryModelPath;
  }

  const legacyModelPath = path.join(uploadDir, `${id}.obj`);
  return fs.existsSync(legacyModelPath) ? legacyModelPath : null;
}

async function ensureModelRender(id, modelPath, refresh) {
  const renderPath = getRenderImagePath(id);
  if (!refresh && fs.existsSync(renderPath)) {
    return renderPath;
  }

  if (!renderJobs.has(id)) {
    renderJobs.set(
      id,
      renderModelImage(id, modelPath, renderPath).finally(() => {
        renderJobs.delete(id);
      }),
    );
  }

  return renderJobs.get(id);
}

async function renderModelImage(id, modelPath, renderPath) {
  fs.mkdirSync(path.dirname(renderPath), { recursive: true });

  const tempPath = `${renderPath}.${crypto.randomUUID()}.tmp`;
  const session = await getRenderSession(id, modelPath);

  try {
    await withRenderSession(session, async () => {
      await setRenderViewport(session, renderWidth, renderHeight);
      await applyRenderCamera(session, null);
      await session.page.screenshot({ path: tempPath, type: 'png', timeout: renderTimeoutMs });
    });
    fs.renameSync(tempPath, renderPath);
    console.log('model-visualizer rendered picture', {
      id,
      modelBytes: fs.statSync(modelPath).size,
      renderPath,
      hotSession: session.renderCount > 0,
    });
    session.renderCount += 1;
    touchRenderSession(id, session);
    return renderPath;
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

async function renderModelImageBuffer(id, modelPath, cameraState) {
  const session = await getRenderSession(id, modelPath);
  const buffer = await withRenderSession(session, async () => {
    await setRenderViewport(session, cameraState.width, cameraState.height);
    await applyRenderCamera(session, cameraState);
    return session.page.screenshot({ type: 'png', timeout: renderTimeoutMs });
  });

  console.log('model-visualizer rendered live picture', {
    id,
    modelBytes: fs.statSync(modelPath).size,
    hotSession: session.renderCount > 0,
    cameraState,
  });
  session.renderCount += 1;
  touchRenderSession(id, session);
  return buffer;
}

async function withRenderSession(session, task) {
  const runTask = async () => {
    if (session.closed) {
      const error = new Error('Render session is no longer available.');
      error.code = 'RENDER_SESSION_CLOSED';
      error.statusCode = 503;
      throw error;
    }

    return withRenderTimeout(Promise.resolve().then(task), session);
  };
  const run = session.queue.then(runTask, runTask);
  session.queue = run.catch(() => {});
  return run;
}

async function withRenderTimeout(promise, session) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`Rendering exceeded ${formatDuration(renderTimeoutMs)}.`);
      error.code = 'RENDER_TIMEOUT';
      error.statusCode = 504;
      closeRenderSession(session.id, session, 'timeout').catch((closeError) => {
        console.error('model-visualizer failed to close timed out render session', {
          id: session.id,
          message: closeError.message,
        });
      });
      reject(error);
    }, renderTimeoutMs);
    timeout.unref?.();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

async function setRenderViewport(session, width, height) {
  if (session.viewport?.width === width && session.viewport?.height === height) {
    return;
  }

  await session.page.setViewport({ width, height, deviceScaleFactor: 1 });
  session.viewport = { width, height };
  await session.page.evaluate(
    () => new Promise((resolve) => {
      window.dispatchEvent(new Event('resize'));
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }),
  );
}

async function applyRenderCamera(session, cameraState) {
  await session.page.evaluate(async (state) => {
    if (typeof window.__MODEL_VISUALIZER_SET_CAMERA__ !== 'function') {
      throw new Error('Snapshot camera controls are not ready.');
    }

    await window.__MODEL_VISUALIZER_SET_CAMERA__(state);
  }, cameraState);
}

async function getRenderSession(id, modelPath) {
  const existing = renderSessions.get(id);
  if (existing?.page) {
    touchRenderSession(id, existing);
    return existing;
  }

  if (existing?.promise) {
    return existing.promise;
  }

  const promise = createRenderSession(id, modelPath);
  renderSessions.set(id, { promise });

  try {
    const session = await promise;
    renderSessions.set(id, session);
    touchRenderSession(id, session);
    return session;
  } catch (error) {
    renderSessions.delete(id);
    throw error;
  }
}

async function createRenderSession(id, modelPath) {
  const virtualDisplay = await startVirtualDisplay();
  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath: getChromiumPath(),
      headless: virtualDisplay.display ? false : 'new',
      env: {
        ...process.env,
        ...(virtualDisplay.display ? { DISPLAY: virtualDisplay.display } : {}),
      },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--hide-scrollbars',
      ],
    });

    const page = await browser.newPage();
    const pageMessages = [];
    page.on('console', (message) => {
      pageMessages.push(`[${message.type()}] ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      pageMessages.push(`[pageerror] ${error.message}`);
    });
    page.setDefaultTimeout(renderTimeoutMs);
    await page.setViewport({ width: renderWidth, height: renderHeight, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${port}${basePath}/snapshot/${id}`, {
      waitUntil: 'domcontentloaded',
      timeout: renderTimeoutMs,
    });

    await page.waitForFunction(
      () => window.__MODEL_VISUALIZER_READY__ === true || Boolean(window.__MODEL_VISUALIZER_ERROR__),
      { timeout: renderTimeoutMs },
    ).catch((error) => {
      error.message = `${error.message}; page messages: ${pageMessages.slice(-8).join(' | ') || 'none'}`;
      throw error;
    });

    const snapshotError = await page.evaluate(() => window.__MODEL_VISUALIZER_ERROR__ || null);
    if (snapshotError) {
      const error = new Error(`Server-side render failed: ${snapshotError}`);
      error.code = 'RENDER_FAILED';
      throw error;
    }

    console.log('model-visualizer warmed render session', {
      id,
      modelBytes: fs.statSync(modelPath).size,
    });

    return {
      id,
      browser,
      page,
      virtualDisplay,
      pageMessages,
      renderCount: 0,
      queue: Promise.resolve(),
      viewport: { width: renderWidth, height: renderHeight },
      closed: false,
      lastAccess: Date.now(),
      cleanupTimer: null,
    };
  } catch (error) {
    await browser?.close();
    virtualDisplay.stop();
    throw error;
  }
}

function touchRenderSession(id, session) {
  session.lastAccess = Date.now();
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  session.cleanupTimer = setTimeout(() => {
    closeRenderSessionIfIdle(id, session).catch((error) => {
      console.error('model-visualizer failed to close render session', {
        id,
        message: error.message,
      });
    });
  }, renderSessionTtlMs);
  session.cleanupTimer.unref?.();
}

function parseRenderCameraQuery(query) {
  const hasCameraParam = ['yaw', 'pitch', 'zoom', 'fov', 'panX', 'panY', 'width', 'height'].some(
    (key) => query[key] !== undefined,
  );
  if (!hasCameraParam) {
    return null;
  }

  return {
    yaw: parseBoundedNumber(query.yaw, -100, 100, 0),
    pitch: parseBoundedNumber(query.pitch, -Math.PI + 0.05, Math.PI - 0.05, 0),
    zoom: parseBoundedNumber(query.zoom, 0.05, 20, 1),
    fov: parseBoundedNumber(query.fov, 10, 100, 45),
    panX: parseBoundedNumber(query.panX, -100, 100, 0),
    panY: parseBoundedNumber(query.panY, -100, 100, 0),
    width: Math.round(parseBoundedNumber(query.width, 120, renderWidth, renderWidth)),
    height: Math.round(parseBoundedNumber(query.height, 80, renderHeight, renderHeight)),
  };
}

function parseBoundedNumber(value, min, max, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    const error = new Error(`Invalid render camera parameter: expected ${min}..${max}.`);
    error.code = 'INVALID_CAMERA';
    error.statusCode = 400;
    throw error;
  }

  return number;
}

async function closeRenderSessionIfIdle(id, session) {
  if (Date.now() - session.lastAccess < renderSessionTtlMs) {
    touchRenderSession(id, session);
    return;
  }

  if (renderSessions.get(id) !== session) {
    return;
  }

  renderSessions.delete(id);
  await closeRenderSession(id, session, 'idle');
}

async function closeRenderSession(id, session, reason) {
  if (session.closed) {
    return;
  }

  session.closed = true;
  if (renderSessions.get(id) === session) {
    renderSessions.delete(id);
  }
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
  }

  await session.browser?.close();
  session.virtualDisplay?.stop();
  console.log('model-visualizer closed render session', { id, reason });
}

async function startVirtualDisplay() {
  if (process.env.DISPLAY) {
    return {
      display: process.env.DISPLAY,
      stop() {},
    };
  }

  const xvfbPath = '/usr/bin/Xvfb';
  if (!fs.existsSync(xvfbPath)) {
    return {
      display: null,
      stop() {},
    };
  }

  const display = `:${100 + Math.floor(Math.random() * 900)}`;
  const xvfbProcess = spawn(xvfbPath, [display, '-screen', '0', `${renderWidth}x${renderHeight}x24`], {
    stdio: 'ignore',
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, 500);
    xvfbProcess.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    xvfbProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Xvfb exited before Chromium started with code ${code}`));
    });
  });

  return {
    display,
    stop() {
      if (!xvfbProcess.killed) {
        xvfbProcess.kill('SIGTERM');
      }
    },
  };
}

function getRenderImagePath(id) {
  const modelDir = path.join(uploadDir, id);
  if (fs.existsSync(modelDir) && fs.statSync(modelDir).isDirectory()) {
    return path.join(modelDir, 'render.png');
  }

  return path.join(renderCacheDir, `${id}.png`);
}

function getChromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);

  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    const error = new Error('Chromium is not installed, so server-side picture mode is unavailable.');
    error.code = 'CHROMIUM_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }

  return executablePath;
}

function getAssetNames(id) {
  const modelDir = path.join(uploadDir, id);
  if (!fs.existsSync(modelDir) || !fs.statSync(modelDir).isDirectory()) {
    return [];
  }

  return fs
    .readdirSync(modelDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'model.obj' && isSafeFileName(entry.name))
    .map((entry) => entry.name);
}

function getReferencedMaterialNames(modelPath) {
  const file = fs.openSync(modelPath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const bytesRead = fs.readSync(file, buffer, 0, buffer.length, 0);
    const preview = buffer.subarray(0, bytesRead).toString('utf8');
    return [
      ...new Set(
        preview
          .split(/\r?\n/)
          .filter((line) => line.toLowerCase().startsWith('mtllib '))
          .flatMap((line) => line.slice(7).trim().split(/\s+/))
          .filter(Boolean),
      ),
    ];
  } finally {
    fs.closeSync(file);
  }
}

function getSafeOriginalFileName(originalName) {
  const filename = path.basename(originalName.replaceAll('\\', '/'));
  if (!isSafeFileName(filename)) {
    throw new Error(`Unsupported filename: ${originalName}`);
  }

  return filename;
}

function isSafeFileName(filename) {
  return (
    filename.length > 0 &&
    filename.length <= 255 &&
    filename === path.basename(filename) &&
    !filename.includes('\0') &&
    filename !== '.' &&
    filename !== '..'
  );
}

function cleanupTempFiles(files) {
  for (const file of files) {
    fs.rmSync(file.path, { force: true });
  }
}

function sendUploadError(req, res, { status, code, message, ...extra }) {
  const debug = {
    requestId: req.requestId,
    code,
    status,
    allowedExtensions: [...allowedUploadExtensions],
    maxUploadBytes,
    maxUploadFiles,
    uploadTimeoutMs,
    ...removeUndefined(extra),
  };

  console.warn('model-visualizer upload failed', debug);
  res.status(status).json({
    error: message,
    debug,
  });
}

function getUploadDebugFiles(files) {
  return files.map((file) => ({
    field: file.fieldname,
    originalName: file.originalname,
    size: file.size,
    extension: path.extname(file.originalname).toLowerCase(),
  }));
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([_key, entryValue]) => entryValue !== undefined));
}

function formatBytes(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function formatDuration(milliseconds) {
  if (milliseconds < 60 * 1000) {
    return `${Math.round(milliseconds / 1000)} sec`;
  }

  return `${Math.round(milliseconds / 1000 / 60)} min`;
}

function cleanupStaleTempUploads() {
  const cutoff = Date.now() - tempUploadMaxAgeMs;

  for (const entry of fs.readdirSync(uploadTmpDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.upload')) {
      continue;
    }

    const filePath = path.join(uploadTmpDir, entry.name);
    const stats = fs.statSync(filePath);
    if (stats.mtimeMs < cutoff) {
      fs.rmSync(filePath, { force: true });
    }
  }
}
