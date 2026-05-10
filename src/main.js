import './styles.css';

import * as THREE from 'three';
import { Box3, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

const pictureWarmupFrame = { maxSide: 180, maxWidth: 180, maxHeight: 180, quality: 45 };
const pictureInteractiveFrame = { maxSide: 360, maxWidth: 480, maxHeight: 480, quality: 55 };
const pictureStillFrame = { maxSide: 1280, maxWidth: 1280, maxHeight: 900, quality: 82 };
const pictureStillDelayMs = 350;

const app = document.querySelector('#app');
const basePath = getBasePath();
const route = getRoute();

if (route.startsWith('/snapshot/')) {
  renderSnapshot(route.split('/')[2]);
} else if (route === '/models') {
  renderModelList();
} else if (route.startsWith('/models/')) {
  renderPictureViewer(route.split('/')[2]);
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
        <p class="lede secondary-link"><a href="${basePath}/models">Browse uploaded models</a></p>
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
        <div class="viewer-links">
          <a class="viewer-link" href="${escapeAttribute(toLocalUrl(payload.url))}">Open viewer</a>
        </div>
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

async function renderModelList() {
  app.innerHTML = `
    <main class="page model-list-page">
      <section class="hero">
        <p class="eyebrow">Model library</p>
        <h1>Uploaded models</h1>
        <p class="lede">Browse the models currently stored on the server. The list shows metadata only; model files remain server-side.</p>
      </section>
      <section class="card">
        <div id="model-list-status" class="list-status">Loading models...</div>
        <div id="model-list" class="model-list" hidden></div>
      </section>
    </main>
  `;

  const status = document.querySelector('#model-list-status');
  const list = document.querySelector('#model-list');

  try {
    const payload = await loadJson(`${basePath}/api/models`);
    const models = payload.models || [];
    status.textContent = `${models.length} ${models.length === 1 ? 'model' : 'models'} stored`;
    list.innerHTML = models.length
      ? models.map(renderModelListItem).join('')
      : '<p class="empty-state">No models have been uploaded yet.</p>';
    list.hidden = false;
  } catch (error) {
    status.className = 'result error';
    status.textContent = `Unable to load model list: ${error.message}`;
  }
}

function renderModelListItem(model) {
  const missingMaterials = model.missingMaterials?.length
    ? `<span class="meta-pill warning">${model.missingMaterials.length} missing material ${model.missingMaterials.length === 1 ? 'file' : 'files'}</span>`
    : '<span class="meta-pill">materials ok</span>';

  return `
    <article class="model-list-item">
      <div class="model-list-main">
        <p class="eyebrow">${escapeHtml(model.storageType)}</p>
        <h2>${escapeHtml(model.name)}</h2>
        <p class="model-id">${escapeHtml(model.id)}</p>
      </div>
      <div class="model-meta-grid">
        <span><strong>Uploaded</strong>${formatDateTime(model.uploadedAt)}</span>
        <span><strong>Updated</strong>${formatDateTime(model.updatedAt)}</span>
        <span><strong>Model size</strong>${formatBytes(model.modelSizeBytes)}</span>
        <span><strong>Total size</strong>${formatBytes(model.totalSizeBytes)}</span>
        <span><strong>Assets</strong>${model.assetCount} files</span>
        <span><strong>Textures</strong>${model.textureCount}</span>
      </div>
      <div class="model-meta-pills">
        <span class="meta-pill">${model.materialCount} material ${model.materialCount === 1 ? 'file' : 'files'}</span>
        ${missingMaterials}
        <span class="meta-pill">${model.renderCached ? 'preview cached' : 'preview not cached'}</span>
      </div>
      <a class="viewer-link" href="${escapeAttribute(toLocalUrl(model.viewerUrl))}">Open preview</a>
    </article>
  `;
}

function renderPictureViewer(modelId) {
  app.innerHTML = `
    <main class="viewer-page picture-page">
      <section class="viewer-shell picture-shell">
        <img id="rendered-picture" class="rendered-picture" alt="Server-rendered preview of the shared 3D model" hidden />
        <div id="viewer-status" class="viewer-status viewer-loading picture-rendering-status" role="status" aria-live="polite">
          <div class="viewer-loading-label">
            <span id="viewer-loading-stage">Warming server renderer...</span>
            <span id="viewer-loading-percent">Loading</span>
          </div>
          <progress id="viewer-loading-bar">Loading</progress>
        </div>
      </section>
    </main>
  `;

  const image = document.querySelector('#rendered-picture');
  const status = document.querySelector('#viewer-status');
  const shell = document.querySelector('.picture-shell');
  const cameraState = {
    yaw: 0,
    pitch: 0,
    zoom: 1,
    fov: 45,
    panX: 0,
    panY: 0,
  };
  const streamState = {
    socket: null,
    nextRequestId: 0,
    latestRequestId: 0,
    requestStartedAt: new Map(),
    pendingFrameMetadata: null,
    loadingFrameMetadata: null,
    currentObjectUrl: null,
    nextObjectUrl: null,
    interactiveFrameRequest: null,
    idleTimer: null,
    pointerId: null,
    lastX: 0,
    lastY: 0,
    dragMode: 'orbit',
    lastDelayMs: null,
    hasDisplayedImage: false,
  };

  image.addEventListener('load', () => {
    const metadata = streamState.loadingFrameMetadata;
    if (metadata) {
      const startedAt = streamState.requestStartedAt.get(metadata.requestId);
      streamState.lastDelayMs = startedAt ? performance.now() - startedAt : metadata.renderMs;
      streamState.requestStartedAt.delete(metadata.requestId);
      streamState.loadingFrameMetadata = null;
    }

    if (streamState.currentObjectUrl) {
      URL.revokeObjectURL(streamState.currentObjectUrl);
    }
    streamState.currentObjectUrl = streamState.nextObjectUrl;
    streamState.nextObjectUrl = null;
    image.hidden = false;
    streamState.hasDisplayedImage = true;
    shell.classList.add('is-ready');
    status.hidden = true;
  });
  image.addEventListener('error', () => {
    status.className = 'viewer-status error';
    status.textContent = 'Unable to load the server-rendered picture.';
  });
  window.addEventListener('beforeunload', () => {
    streamState.socket?.close();
    if (streamState.currentObjectUrl) {
      URL.revokeObjectURL(streamState.currentObjectUrl);
    }
    if (streamState.nextObjectUrl) {
      URL.revokeObjectURL(streamState.nextObjectUrl);
    }
  }, { once: true });
  window.addEventListener('resize', () => {
    schedulePictureStillFrame(image, status, cameraState, streamState);
  });
  openPictureStream(modelId, image, status, cameraState, streamState);

  shell.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    shell.setPointerCapture(event.pointerId);
    streamState.pointerId = event.pointerId;
    streamState.lastX = event.clientX;
    streamState.lastY = event.clientY;
    streamState.dragMode = event.button === 2 ? 'pan' : 'orbit';
    shell.classList.add('dragging');
  });

  shell.addEventListener('pointermove', (event) => {
    if (streamState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - streamState.lastX;
    const deltaY = event.clientY - streamState.lastY;
    streamState.lastX = event.clientX;
    streamState.lastY = event.clientY;
    if (streamState.dragMode === 'pan') {
      cameraState.panX -= deltaX * 0.002;
      cameraState.panY += deltaY * 0.002;
    } else {
      cameraState.yaw -= deltaX * 0.01;
      cameraState.pitch = clamp(cameraState.pitch - deltaY * 0.01, -Math.PI + 0.1, Math.PI - 0.1);
    }

    markPictureDirty(modelId, image, status, cameraState, streamState);
  });

  shell.addEventListener('pointerup', (event) => {
    if (streamState.pointerId === event.pointerId) {
      streamState.pointerId = null;
      shell.classList.remove('dragging');
      schedulePictureStillFrame(image, status, cameraState, streamState);
    }
  });

  shell.addEventListener('pointercancel', () => {
    streamState.pointerId = null;
    shell.classList.remove('dragging');
    schedulePictureStillFrame(image, status, cameraState, streamState);
  });

  shell.addEventListener('wheel', (event) => {
    event.preventDefault();
    cameraState.zoom = clamp(cameraState.zoom * Math.exp(event.deltaY * 0.001), 0.08, 12);
    markPictureDirty(modelId, image, status, cameraState, streamState);
  }, { passive: false });

  shell.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });
}

function renderSnapshot(modelId) {
  app.innerHTML = `
    <main class="snapshot-page">
      <div id="canvas-host" class="canvas-host"></div>
      <div id="viewer-status" class="viewer-status viewer-loading" hidden>
        <div class="viewer-loading-label">
          <span id="viewer-loading-stage">Loading model...</span>
          <span id="viewer-loading-percent">0%</span>
        </div>
        <progress id="viewer-loading-bar" max="100" value="0">0%</progress>
      </div>
    </main>
  `;

  window.__MODEL_VISUALIZER_READY__ = false;
  window.__MODEL_VISUALIZER_ERROR__ = null;
  loadModel(modelId, {
    snapshot: true,
    onReady: () => {
      window.__MODEL_VISUALIZER_READY__ = true;
    },
    onError: (error) => {
      window.__MODEL_VISUALIZER_ERROR__ = error.stack || error.message;
    },
  }).catch((error) => {
    window.__MODEL_VISUALIZER_ERROR__ = error.stack || error.message;
  });
}

async function loadModel(modelId, options = {}) {
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
    installSnapshotCameraControls(camera, controls);
    renderOnce(renderer, scene, camera, controls, options.onReady);

    if (!options.snapshot && manifest.missingMaterials?.length > 0) {
      status.hidden = false;
      status.className = 'viewer-status warning';
      status.textContent = `Rendered without some colors: missing ${manifest.missingMaterials.join(', ')}. Re-upload the OBJ together with its MTL/material files.`;
    } else {
      status.hidden = true;
    }
  } catch (error) {
    status.className = 'viewer-status error';
    status.textContent = `Unable to load model: ${error.message}`;
    options.onError?.(error);
  }

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

function installSnapshotCameraControls(camera, controls) {
  const baseTarget = controls.target.clone();
  const baseSpherical = new THREE.Spherical().setFromVector3(camera.position.clone().sub(baseTarget));
  const baseRadius = baseSpherical.radius;

  window.__MODEL_VISUALIZER_SET_CAMERA__ = (state) => new Promise((resolve) => {
    const nextState = state || {};
    const spherical = baseSpherical.clone();
    spherical.theta += Number(nextState.yaw || 0);
    spherical.phi = clamp(spherical.phi + Number(nextState.pitch || 0), 0.05, Math.PI - 0.05);
    spherical.radius *= Number(nextState.zoom || 1);

    const relativePosition = new Vector3().setFromSpherical(spherical);
    camera.position.copy(baseTarget).add(relativePosition);
    camera.fov = Number(nextState.fov || 45);
    camera.updateProjectionMatrix();
    controls.target.copy(baseTarget);
    controls.update();

    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const panOffset = right
      .multiplyScalar(Number(nextState.panX || 0) * baseRadius)
      .add(up.multiplyScalar(Number(nextState.panY || 0) * baseRadius));
    controls.target.copy(baseTarget).add(panOffset);
    camera.position.add(panOffset);
    controls.update();

    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

function renderOnce(renderer, scene, camera, controls, onReady) {
  requestAnimationFrame(() => {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(() => {
      renderer.render(scene, camera);
      onReady?.();
    });
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

function openPictureStream(modelId, image, status, cameraState, streamState) {
  const socket = new WebSocket(getPictureStreamUrl(modelId));
  socket.binaryType = 'blob';
  streamState.socket = socket;
  showPictureStatus(status, 'Connecting renderer...', 'Stream');

  socket.addEventListener('open', () => {
    sendPictureStreamRequest(image, status, cameraState, streamState, 'warmup');
    schedulePictureStillFrame(image, status, cameraState, streamState);
  });

  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      handlePictureStreamMetadata(event.data, status, streamState);
      return;
    }

    handlePictureStreamFrame(event.data, image, streamState);
  });

  socket.addEventListener('close', () => {
    if (!streamState.hasDisplayedImage) {
      status.hidden = false;
      status.className = 'viewer-status error';
      status.textContent = 'The server render stream closed before a preview was ready.';
    }
  });

  socket.addEventListener('error', () => {
    status.hidden = false;
    status.className = 'viewer-status error';
    status.textContent = 'Unable to connect to the server render stream.';
  });
}

function markPictureDirty(_modelId, image, status, cameraState, streamState) {
  clearTimeout(streamState.idleTimer);
  if (streamState.interactiveFrameRequest) {
    return;
  }

  streamState.interactiveFrameRequest = requestAnimationFrame(() => {
    streamState.interactiveFrameRequest = null;
    sendPictureStreamRequest(image, status, cameraState, streamState, 'interactive');
    schedulePictureStillFrame(image, status, cameraState, streamState);
  });
}

function schedulePictureStillFrame(image, status, cameraState, streamState) {
  clearTimeout(streamState.idleTimer);
  streamState.idleTimer = setTimeout(() => {
    sendPictureStreamRequest(image, status, cameraState, streamState, 'still');
  }, pictureStillDelayMs);
}

function sendPictureStreamRequest(_image, status, cameraState, streamState, mode) {
  if (streamState.socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  const frame = getPictureFrameSettings(mode);
  const requestId = streamState.nextRequestId + 1;
  streamState.nextRequestId = requestId;
  streamState.latestRequestId = requestId;
  streamState.requestStartedAt.set(requestId, performance.now());
  showPictureStatus(
    status,
    mode === 'still' ? `Rendering detailed view at ${frame.width}x${frame.height}...` : `Rendering latest view at ${frame.width}x${frame.height}...`,
    streamState.lastDelayMs === null ? 'JPEG' : `${Math.round(streamState.lastDelayMs)}ms`,
  );

  streamState.socket.send(JSON.stringify({
    type: 'camera',
    requestId,
    mode,
    yaw: Number(cameraState.yaw.toFixed(4)),
    pitch: Number(cameraState.pitch.toFixed(4)),
    zoom: Number(cameraState.zoom.toFixed(4)),
    fov: cameraState.fov,
    panX: Number(cameraState.panX.toFixed(4)),
    panY: Number(cameraState.panY.toFixed(4)),
    width: frame.width,
    height: frame.height,
    quality: frame.quality,
  }));
}

function handlePictureStreamMetadata(message, status, streamState) {
  const metadata = JSON.parse(message);
  if (metadata.type === 'ready') {
    showPictureStatus(status, 'Warming server renderer...', 'Stream');
    return;
  }

  if (metadata.type === 'error') {
    status.hidden = false;
    status.className = 'viewer-status error';
    status.textContent = metadata.error || 'Server render stream failed.';
    return;
  }

  if (metadata.type === 'frame') {
    streamState.pendingFrameMetadata = metadata;
  }
}

function handlePictureStreamFrame(blob, image, streamState) {
  const metadata = streamState.pendingFrameMetadata;
  streamState.pendingFrameMetadata = null;
  if (!metadata) {
    return;
  }

  streamState.loadingFrameMetadata = metadata;
  if (streamState.nextObjectUrl) {
    URL.revokeObjectURL(streamState.nextObjectUrl);
  }
  streamState.nextObjectUrl = URL.createObjectURL(blob);
  image.src = streamState.nextObjectUrl;
}

function getPictureFrameSettings(mode) {
  const preset = mode === 'still'
    ? pictureStillFrame
    : mode === 'warmup'
      ? pictureWarmupFrame
      : pictureInteractiveFrame;
  const { width, height } = getViewportMatchedFrameSize(preset);
  return { ...preset, width, height };
}

function getViewportMatchedFrameSize({ maxSide, maxWidth, maxHeight }) {
  const viewportWidth = Math.max(1, Math.round(window.visualViewport?.width || window.innerWidth || document.documentElement.clientWidth || 1));
  const viewportHeight = Math.max(1, Math.round(window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 1));
  const aspect = viewportWidth / viewportHeight;
  let width;
  let height;

  if (aspect >= 1) {
    width = maxSide;
    height = Math.round(maxSide / aspect);
  } else {
    height = maxSide;
    width = Math.round(maxSide * aspect);
  }

  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(64, Math.round(width * scale)),
    height: Math.max(64, Math.round(height * scale)),
  };
}

function showPictureStatus(status, label, detail) {
  status.hidden = false;
  status.className = 'viewer-status viewer-loading picture-rendering-status';
  status.innerHTML = `
    <div class="viewer-loading-label">
      <span>${label}</span>
      <span>${detail}</span>
    </div>
    <progress>Rendering</progress>
  `;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function getPictureStreamUrl(modelId) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${basePath}/api/models/${modelId}/render-stream`;
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
  if (!Number.isFinite(bytes)) {
    return 'Unknown';
  }

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

function formatDateTime(value) {
  if (!value) {
    return 'Unknown';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
