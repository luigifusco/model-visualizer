# Model Visualizer

A web app for uploading Wavefront OBJ models and sharing browser-viewable 3D render URLs.

## Features

- Upload one `.obj` model with optional `.mtl` material files and common texture images.
- Shows upload progress for large models.
- Stores uploaded assets on disk and returns a shareable viewer URL.
- Renders shared models with Three.js, OBJLoader, MTLLoader, and orbit controls.
- Shows model-loading progress in the fullscreen viewer.
- Provides a server-rendered picture mode that sends a cached PNG instead of the full model to viewers.
- Reports safe debug information when uploads fail.
- Supports large uploads through configurable size and timeout limits.

## Development

```bash
npm install
npm run dev
```

The development server defaults to local paths. Production paths are configured through environment variables.

## Production build

```bash
npm run build
npm start
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port for the Express server. |
| `BASE_PATH` | empty | Path prefix used behind a reverse proxy, for example `/model-visualizer`. |
| `PUBLIC_BASE_URL` | `http://localhost:${PORT}${BASE_PATH}` | Public URL used when generating share links. |
| `UPLOAD_DIR` | `./uploads` | Directory where uploaded model assets are stored. |
| `MAX_UPLOAD_BYTES` | `104857600` | Per-file upload limit in bytes. |
| `MAX_UPLOAD_FILES` | `20` | Maximum number of files in one upload. |
| `UPLOAD_TIMEOUT_MS` | `1800000` | Server request timeout for uploads. |
| `TEMP_UPLOAD_MAX_AGE_MS` | `86400000` | Age after which interrupted temporary uploads are cleaned up. |
| `CHROMIUM_PATH` | auto-detected | Chromium executable path used for server-rendered picture mode. |
| `RENDER_WIDTH` | `1280` | Width of generated server-side PNG renders. |
| `RENDER_HEIGHT` | `900` | Height of generated server-side PNG renders. |
| `RENDER_TIMEOUT_MS` | `600000` | Maximum time allowed for one server-side render. |
| `RENDER_SESSION_TTL_MS` | `60000` | Time to keep a model render session hot after a picture render. |

## Docker

```bash
docker build -t model-visualizer .
docker run --rm -p 8080:8080 -v "$PWD/uploads:/app/uploads" model-visualizer
```

The current host deployment is managed separately from `/home/luigifusco/Carlo/docker/model-visualizer` and mounts uploaded assets from the NAS.
