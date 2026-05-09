FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
ARG BASE_PATH=/model-visualizer
ENV VITE_BASE_PATH=${BASE_PATH}
RUN npm run build -- --base=${BASE_PATH}/

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    BASE_PATH=/model-visualizer \
    PUBLIC_BASE_URL=https://luigifusco.dev/model-visualizer \
    UPLOAD_DIR=/app/uploads

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./server.js
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/uploads && chown -R node:node /app

USER node
EXPOSE 8080

CMD ["node", "server.js"]
