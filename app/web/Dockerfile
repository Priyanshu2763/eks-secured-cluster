# syntax=docker/dockerfile:1

# ---- build -----------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src

# The API base URL is baked into the bundle at BUILD time, because a static SPA
# has no server to read env vars from at runtime. That means a different API
# endpoint requires a rebuild — the usual trade for shipping plain static
# files. (The alternative is fetching a /config.json at startup; not worth the
# extra round trip here.)
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

# ---- runtime ---------------------------------------------------------------
# nginx-unprivileged runs as uid 101 and binds a high port out of the box,
# which is what lets the container drop every capability and run with a
# read-only root filesystem.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# CSP values differ per environment, so the config is a template and nginx's
# entrypoint substitutes these at container start. Defaults are permissive
# enough to work with a same-origin API; override them in the task definition
# or pod spec.
ENV API_ORIGIN=""
ENV MEDIA_SRC="https://*.s3.amazonaws.com https://*.amazonaws.com"

# Render templates over /etc/nginx (not the default conf.d), because this is a
# COMPLETE nginx.conf with its own events{} and http{} blocks. Dropped into
# conf.d it would be included *inside* the stock http block and fail to parse.
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx

# Substitute ONLY these two variables. Without a filter, envsubst would also
# rewrite nginx's own runtime variables — $uri, $args, $host — into empty
# strings, silently breaking try_files and the SPA fallback. This is the
# classic way to break an nginx template.
ENV NGINX_ENVSUBST_FILTER="^(API_ORIGIN|MEDIA_SRC)$"

COPY --chown=101:101 nginx.conf /etc/nginx/templates/nginx.conf.template
COPY --chown=101:101 .htpasswd /etc/nginx/.htpasswd
COPY --from=build --chown=101:101 /app/dist /usr/share/nginx/html

EXPOSE 8080
