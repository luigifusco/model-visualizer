import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';

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
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const maxUploadFiles = Number(process.env.MAX_UPLOAD_FILES || 20);
const uploadTimeoutMs = Number(process.env.UPLOAD_TIMEOUT_MS || 30 * 60 * 1000);
const tempUploadMaxAgeMs = Number(process.env.TEMP_UPLOAD_MAX_AGE_MS || 24 * 60 * 60 * 1000);
const isProduction = process.env.NODE_ENV === 'production';
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

app.use((err, req, res, _next) => {
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
