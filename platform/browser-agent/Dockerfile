FROM node:22-bookworm-slim AS native-build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      libx11-dev \
      libxtst-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /native/x11-inputd
COPY platform/browser-agent/native/x11-inputd ./
RUN make

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    WAR_AGENT_HOST=127.0.0.1 \
    WAR_AGENT_PORT=3766 \
    WAR_DATA_DIR=/data \
    WAR_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
    WAR_EXTENSION_DIR=/app/extension \
    WAR_BROWSER_HEADLESS=false \
    DISPLAY=:99

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      chromium-sandbox \
      dumb-init \
      fonts-liberation \
      fonts-noto-color-emoji \
      libx11-6 \
      libxtst6 \
      x11-utils \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY platform/browser-agent/src ./platform/browser-agent/src
COPY platform/protocol/src ./platform/protocol/src
COPY platform/protocol/schemas ./platform/protocol/schemas
COPY native-host ./native-host
COPY manifest.json ./extension/manifest.json
COPY src ./extension/src
COPY ui ./extension/ui
COPY --from=native-build /native/x11-inputd/war-x11-inputd /usr/local/bin/war-x11-inputd

RUN printf '%s\n' '#!/bin/sh' 'export WAR_DATA_DIR="${WAR_DATA_DIR:-/data}"' 'export WAR_AGENT_SOCKET_PATH="${WAR_AGENT_SOCKET_PATH:-/data/run/native-bridge.sock}"' 'exec node /app/native-host/host.js' > /usr/local/bin/war-native-host \
    && chmod +x /usr/local/bin/war-native-host

RUN useradd --create-home --shell /usr/sbin/nologin war \
    && mkdir -p /data/device /data/chromium-profile /data/downloads /data/uploads /data/logs /run/war \
    && chown -R war:war /data /app /run/war \
    && chmod 0700 /run/war

COPY platform/browser-agent/docker-entrypoint.sh /usr/local/bin/browser-agent-entrypoint
RUN chmod +x /usr/local/bin/browser-agent-entrypoint

USER war
EXPOSE 3766
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/browser-agent-entrypoint"]
CMD ["node", "platform/browser-agent/src/agent.js"]
