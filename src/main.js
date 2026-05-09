import './styles.css';

import * as THREE from 'three';
import { Box3, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

const app = document.querySelector('#app');
const basePath = getBasePath();
const route = getRoute();

if (route.startsWith('/models/')) {
  renderViewer(route.split('/')[2]);
} else {
  renderUploader();
}

function renderUploader() {
  app.innerHTML = `
    <main class="page">
      <section class="hero">
        <p class="eyebrow">OBJ sharing</p>
        <h1>Upload a 3D model and share a viewer URL.</h1>
        <p class="lede">Choose a Wavefront <code>.obj</code> file. Add its <code>.mtl</code> and texture images too when the model uses colors or materials.</p>
      </section>

      <section class="card">
        <form id="upload-form" class="upload-form">
          <label class="drop-zone" for="model-input">
            <span class="drop-title">Select OBJ, MTL, and texture files</span>
            <span id="file-name" class="drop-subtitle">No file selected</span>
            <input id="model-input" name="files" type="file" accept=".obj,.mtl,.jpg,.jpeg,.png,.webp,.gif,.bmp" multiple required />
          </label>
          <button id="upload-button" type="submit">Upload model</button>
          <div id="upload-progress" class="upload-progress" hidden>
            <div class="progress-label">
              <span id="progress-status">Uploading...</span>
              <span id="progress-percent">0%</span>
            </div>
            <progress id="progress-bar" max="100" value="0">0%</progress>
          </div>
        </form>
        <div id="result" class="result" hidden></div>
      </section>
    </main>
  `;

  const form = document.querySelector('#upload-form');
  const fileInput = document.querySelector('#model-input');
  const fileName = document.querySelector('#file-name');
  const button = document.querySelector('#upload-button');
  const result = document.querySelector('#result');
  const progress = document.querySelector('#upload-progress');
  const progressBar = document.querySelector('#progress-bar');
  const progressStatus = document.querySelector('#progress-status');
  const progressPercent = document.querySelector('#progress-percent');

  fileInput.addEventListener('change', () => {
    fileName.textContent = formatSelectedFiles(fileInput.files);
    resetProgress(progress, progressBar, progressStatus, progressPercent);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    result.hidden = true;
    resetProgress(progress, progressBar, progressStatus, progressPercent);
    progress.hidden = false;
    button.disabled = true;
    button.textContent = 'Uploading...';

    try {
      const body = new FormData(form);
      const selectedFiles = getSelectedFileDebug(fileInput.files);
      const progressState = {
        loaded: 0,
        total: selectedFiles.reduce((sum, file) => sum + file.size, 0),
        lengthComputable: true,
      };
      const payload = await uploadModel(body, ({ loaded, total, lengthComputable }) => {
        progressState.loaded = loaded;
        progressState.total = lengthComputable ? total : progressState.total;
        progressState.lengthComputable = lengthComputable;

        if (!lengthComputable) {
          progressBar.removeAttribute('value');
          progressStatus.textContent = formatBytes(loaded);
          progressPercent.textContent = 'Uploading';
          return;
        }

        const percent = Math.min(100, Math.round((loaded / total) * 100));
        progressBar.value = percent;
        progressBar.textContent = `${percent}%`;
        progressStatus.textContent = `${formatBytes(loaded)} of ${formatBytes(total)}`;
        progressPercent.textContent = `${percent}%`;

        if (percent === 100) {
          button.textContent = 'Processing...';
          progressStatus.textContent = 'Upload complete. Processing model...';
        }
      });

      result.className = 'result success';
      result.innerHTML = `
        <p>Your model is ready:</p>
        <div class="share-row">
          <input id="share-url" value="${escapeAttribute(payload.url)}" readonly />
          <button id="copy-button" type="button">Copy</button>
        </div>
        <a class="viewer-link" href="${escapeAttribute(toLocalUrl(payload.url))}">Open viewer</a>
      `;
      result.hidden = false;

      document.querySelector('#copy-button').addEventListener('click', async () => {
        await navigator.clipboard.writeText(payload.url);
        document.querySelector('#copy-button').textContent = 'Copied';
      });
    } catch (error) {
      result.className = 'result error';
      result.innerHTML = renderUploadError(error, {
        selectedFiles: getSelectedFileDebug(fileInput.files),
        progress: getProgressDebug(progressBar, progressStatus, progressPercent),
      });
      result.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Upload model';
      progress.hidden = true;
    }
  });
}

function uploadModel(body, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const progressState = {
      loaded: 0,
      total: 0,
      lengthComputable: false,
    };

    request.upload.addEventListener('progress', (event) => {
      progressState.loaded = event.loaded;
      progressState.total = event.total;
      progressState.lengthComputable = event.lengthComputable;
      onProgress({
        loaded: event.loaded,
        total: event.total,
        lengthComputable: event.lengthComputable,
      });
    });

    request.addEventListener('load', () => {
      const payload = parseJsonResponse(request.responseText);
      if (request.status >= 200 && request.status < 300) {
        resolve(payload);
        return;
      }

      reject(
        createUploadError(payload.error || 'Upload failed.', {
          httpStatus: request.status,
          httpStatusText: request.statusText,
          requestId: request.getResponseHeader('X-Request-ID') || payload.debug?.requestId,
          server: payload.debug,
          progress: progressState,
        }),
      );
    });

    request.addEventListener('error', () => {
      reject(
        createUploadError('Network error while uploading the model.', {
          event: 'network-error',
          httpStatus: request.status,
          readyState: request.readyState,
          progress: progressState,
        }),
      );
    });

    request.addEventListener('abort', () => {
      reject(
        createUploadError('Upload was cancelled.', {
          event: 'abort',
          httpStatus: request.status,
          readyState: request.readyState,
          progress: progressState,
        }),
      );
    });

    request.open('POST', `${basePath}/api/models`);
    request.send(body);
  });
}

function createUploadError(message, debug) {
  const error = new Error(message);
  error.debug = debug;
  return error;
}

function renderViewer(modelId) {
  app.innerHTML = `
    <main class="viewer-page">
      <header class="viewer-header">
        <a href="${basePath || '/'}">Upload another</a>
        <div>
          <p class="eyebrow">3D viewer</p>
          <h1>Shared OBJ model</h1>
        </div>
      </header>
      <section class="viewer-shell">
        <div id="canvas-host" class="canvas-host"></div>
        <div id="viewer-status" class="viewer-status viewer-loading" role="status" aria-live="polite">
          <div class="viewer-loading-label">
            <span id="viewer-loading-stage">Loading model...</span>
            <span id="viewer-loading-percent">0%</span>
          </div>
          <progress id="viewer-loading-bar" max="100" value="0">0%</progress>
        </div>
      </section>
    </main>
  `;

  loadModel(modelId);
}

async function loadModel(modelId) {
  const host = document.querySelector('#canvas-host');
  const status = document.querySelector('#viewer-status');
  const loadingStage = document.querySelector('#viewer-loading-stage');
  const loadingPercent = document.querySelector('#viewer-loading-percent');
  const loadingBar = document.querySelector('#viewer-loading-bar');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  camera.position.set(3, 2, 5);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.append(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x445577, 2.5));

  const keyLight = new THREE.DirectionalLight(0xffffff, 2);
  keyLight.position.set(5, 6, 7);
  scene.add(keyLight);

  const grid = new THREE.GridHelper(10, 10, 0x3d4b66, 0x1d2940);
  scene.add(grid);

  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  };

  window.addEventListener('resize', resize);
  resize();

  try {
    updateViewerProgress({ loadingBar, loadingStage, loadingPercent }, 5, 'Loading model manifest...');
    const manifest = await loadJson(`${basePath}/api/models/${modelId}/manifest`);
    const objectLoader = new OBJLoader();

    if (manifest.materials?.length > 0) {
      const materialLoader = new MTLLoader();
      materialLoader.setResourcePath(`${basePath}/api/models/${modelId}/assets/`);

      const materials = await materialLoader.loadAsync(manifest.materials[0].url, (event) => {
        updateViewerTransferProgress(
          { loadingBar, loadingStage, loadingPercent },
          event,
          10,
          30,
          'Loading materials...',
        );
      });
      materials.preload();
      objectLoader.setMaterials(materials);
    } else {
      updateViewerProgress({ loadingBar, loadingStage, loadingPercent }, 30, 'Preparing model...');
    }

    const object = await objectLoader.loadAsync(manifest.objUrl, (event) => {
      updateViewerTransferProgress(
        { loadingBar, loadingStage, loadingPercent },
        event,
        30,
        90,
        'Downloading model...',
      );
    });
    updateViewerProgress({ loadingBar, loadingStage, loadingPercent }, 95, 'Parsing model...');
    applyDefaultMaterial(object);
    scene.add(object);
    frameObject(object, camera, controls);
    if (manifest.missingMaterials?.length > 0) {
      status.hidden = false;
      status.className = 'viewer-status warning';
      status.textContent = `Rendered without some colors: missing ${manifest.missingMaterials.join(', ')}. Re-upload the OBJ together with its MTL/material files.`;
    } else {
      status.hidden = true;
    }
  } catch (error) {
    status.className = 'viewer-status error';
    status.textContent = `Unable to load model: ${error.message}`;
  }

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

function updateViewerTransferProgress(elements, event, startPercent, endPercent, label) {
  if (!event.lengthComputable || event.total === 0) {
    elements.loadingBar.removeAttribute('value');
    elements.loadingStage.textContent = event.loaded > 0 ? `${label} ${formatBytes(event.loaded)}` : label;
    elements.loadingPercent.textContent = 'Loading';
    return;
  }

  const transferPercent = Math.min(1, event.loaded / event.total);
  const percent = startPercent + transferPercent * (endPercent - startPercent);
  updateViewerProgress(elements, percent, `${label} ${formatBytes(event.loaded)} of ${formatBytes(event.total)}`);
}

function updateViewerProgress({ loadingBar, loadingStage, loadingPercent }, value, label) {
  const percent = Math.min(100, Math.max(0, Math.round(value)));
  loadingBar.value = percent;
  loadingBar.textContent = `${percent}%`;
  loadingStage.textContent = label;
  loadingPercent.textContent = `${percent}%`;
}

function applyDefaultMaterial(object) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xd8e4ff,
    roughness: 0.65,
    metalness: 0.05,
  });

  object.traverse((child) => {
    if (child.isMesh && !child.material) {
      child.material = child.geometry?.hasAttribute('color')
        ? material.clone()
        : material;
    }

    if (child.isMesh && child.geometry?.hasAttribute('color')) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const meshMaterial of materials) {
        meshMaterial.vertexColors = true;
        meshMaterial.needsUpdate = true;
      }
    }
  });
}

function frameObject(object, camera, controls) {
  const box = new Box3().setFromObject(object);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const maxSize = Math.max(size.x, size.y, size.z) || 1;
  const distance = maxSize / (2 * Math.tan((Math.PI * camera.fov) / 360));

  object.position.sub(center);
  camera.position.set(distance * 0.8, distance * 0.55, distance * 1.25);
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.update();
}

function getBasePath() {
  const configured = import.meta.env.BASE_URL.replace(/\/+$/g, '');
  return configured === '/' ? '' : configured;
}

function getRoute() {
  const path = window.location.pathname;
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

function toLocalUrl(url) {
  const parsed = new URL(url, window.location.origin);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

async function loadJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Request failed.');
  }

  return payload;
}

function resetProgress(progress, progressBar, progressStatus, progressPercent) {
  progress.hidden = true;
  progressBar.value = 0;
  progressBar.textContent = '0%';
  progressStatus.textContent = 'Uploading...';
  progressPercent.textContent = '0%';
}

function formatSelectedFiles(files) {
  if (!files.length) {
    return 'No file selected';
  }

  if (files.length === 1) {
    return files[0].name;
  }

  const objFile = [...files].find((file) => file.name.toLowerCase().endsWith('.obj'));
  return `${files.length} files selected${objFile ? `, including ${objFile.name}` : ''}`;
}

function renderUploadError(error, context) {
  const debug = {
    message: error.message,
    ...context,
    ...(error.debug || {}),
  };

  return `
    <p><strong>Upload failed:</strong> ${escapeHtml(error.message)}</p>
    <details class="debug-details">
      <summary>Debug information</summary>
      <pre>${escapeHtml(JSON.stringify(debug, null, 2))}</pre>
    </details>
  `;
}

function getSelectedFileDebug(files) {
  return [...files].map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type || '(unknown)',
    lastModified: file.lastModified,
  }));
}

function getProgressDebug(progressBar, progressStatus, progressPercent) {
  return {
    value: progressBar.hasAttribute('value') ? Number(progressBar.value) : null,
    status: progressStatus.textContent,
    percent: progressPercent.textContent,
  };
}

function parseJsonResponse(responseText) {
  try {
    return responseText ? JSON.parse(responseText) : {};
  } catch {
    return {};
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
