FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS native-build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      libx11-dev \
      libxtst-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /native/x11-inputd
COPY platform/browser-agent/native/x11-inputd ./
COPY platform/browser-agent/native/cloakbrowser-sandbox-launcher.c ./cloakbrowser-sandbox-launcher.c
COPY platform/browser-agent/native/native-bridge-policy-probe.c ./native-bridge-policy-probe.c
COPY platform/browser-agent/native/native-host-launcher.c ./native-host-launcher.c
RUN make \
    && cc -D_POSIX_C_SOURCE=200809L -std=c11 -O2 -Wall -Wextra -Werror -Wl,-z,relro,-z,now -o war-cloakbrowser-sandbox-launcher cloakbrowser-sandbox-launcher.c \
    && cc -D_POSIX_C_SOURCE=200809L -std=c11 -O2 -Wall -Wextra -Werror -Wl,-z,relro,-z,now -o war-native-bridge-policy-probe native-bridge-policy-probe.c \
    && cc -D_POSIX_C_SOURCE=200809L -std=c11 -O2 -Wall -Wextra -Werror -Wl,-z,relro,-z,now -o war-native-host-launcher native-host-launcher.c

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS xclip-sensitive-build

ARG XCLIP_COMMIT=2c3b811002b35d3be7f39cc1145dd06bdb32e31c
ARG XCLIP_ARCHIVE_SHA256=2bb193f5ac15872bc1b2579643bebf6303804b98e7b6bcc55ff2be9921843a4a
ARG XCLIP_LICENSE=GPL-2.0-or-later

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      autoconf \
      automake \
      build-essential \
      ca-certificates \
      curl \
      libtool \
      libx11-dev \
      libxmu-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build/xclip
RUN curl --fail --location --retry 3 --output /tmp/xclip.tar.gz "https://github.com/astrand/xclip/archive/${XCLIP_COMMIT}.tar.gz" \
    && echo "${XCLIP_ARCHIVE_SHA256}  /tmp/xclip.tar.gz" | sha256sum --check --status \
    && tar --extract --gzip --file /tmp/xclip.tar.gz --strip-components=1 \
    && autoreconf --install --force \
    && ./configure --prefix=/usr/local \
    && make -j"$(nproc)" \
    && strip xclip \
    && ./xclip -help 2>&1 | grep --quiet -- '-sensitive' \
    && ./xclip -help 2>&1 | grep --quiet -- '-wait' \
    && test -x xclip

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS cloakbrowser-build

ARG CLOAKBROWSER_VERSION=146.0.7680.177.5
ARG CLOAKBROWSER_ARCHIVE_SHA256=4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e

ENV CLOAKBROWSER_CACHE_DIR=/opt/war/cloakbrowser \
    CLOAKBROWSER_VERSION=${CLOAKBROWSER_VERSION} \
    CLOAKBROWSER_ARCHIVE_SHA256=${CLOAKBROWSER_ARCHIVE_SHA256} \
    CLOAKBROWSER_AUTO_UPDATE=false

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
RUN node --input-type=module -e "import { ensureBinary } from 'cloakbrowser'; import { fetchSignedManifest, parseChecksums, verifySignature } from './node_modules/cloakbrowser/dist/download.js'; const version=process.env.CLOAKBROWSER_VERSION; const expected=process.env.CLOAKBROWSER_ARCHIVE_SHA256; const manifest=await fetchSignedManifest(version); if(!manifest) throw new Error('signed CloakBrowser manifest unavailable'); verifySignature(manifest.manifestBytes, manifest.sigBytes); const checks=parseChecksums(new TextDecoder().decode(manifest.manifestBytes)); if(checks.get('cloakbrowser-linux-x64.tar.gz')!==expected) throw new Error('CloakBrowser archive digest mismatch'); const binary=await ensureBinary(undefined, version); if(binary!=='/opt/war/cloakbrowser/chromium-'+version+'/chrome') throw new Error('unexpected CloakBrowser binary path');" \
    && test ! -e /root/.cloakbrowser/license.key

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ARG WAR_SOURCE_REVISION=unknown
ARG CLOAKBROWSER_VERSION=146.0.7680.177.5
ARG CLOAKBROWSER_WRAPPER_VERSION=0.5.5
ARG CLOAKBROWSER_ARCHIVE_SHA256=4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e
ARG XCLIP_COMMIT=2c3b811002b35d3be7f39cc1145dd06bdb32e31c
ARG XCLIP_ARCHIVE_SHA256=2bb193f5ac15872bc1b2579643bebf6303804b98e7b6bcc55ff2be9921843a4a
ARG XCLIP_LICENSE=GPL-2.0-or-later

LABEL org.opencontainers.image.revision="${WAR_SOURCE_REVISION}" \
      com.web-action-recorder.remote-control="v1" \
      com.web-action-recorder.browser-engine="cloakbrowser" \
      com.web-action-recorder.browser-engine-version="${CLOAKBROWSER_WRAPPER_VERSION}" \
      com.web-action-recorder.browser-binary-version="${CLOAKBROWSER_VERSION}" \
      com.web-action-recorder.browser-archive-sha256="${CLOAKBROWSER_ARCHIVE_SHA256}" \
      com.web-action-recorder.xclip-source-commit="${XCLIP_COMMIT}" \
      com.web-action-recorder.xclip-source-sha256="${XCLIP_ARCHIVE_SHA256}" \
      com.web-action-recorder.xclip-license="${XCLIP_LICENSE}"

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    WAR_AGENT_HOST=127.0.0.1 \
    WAR_AGENT_PORT=3766 \
    WAR_DATA_DIR=/data \
    WAR_BROWSER_ENGINE=cloakbrowser \
    WAR_CLOAKBROWSER_EXECUTABLE=/usr/local/bin/war-cloakbrowser-sandbox-launcher \
    WAR_CLOAKBROWSER_VERSION=146.0.7680.177.5 \
    WAR_EXTENSION_DIR=/app/extension \
    WAR_BROWSER_HEADLESS=false \
    DISPLAY=:99

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      dumb-init \
      fonts-liberation \
      fonts-noto-color-emoji \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libx11-xcb1 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      libxshmfence1 \
      libxtst6 \
      xclip \
      x11-utils \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY platform/browser-agent/src ./platform/browser-agent/src
COPY platform/diagnostics/src ./platform/diagnostics/src
COPY platform/protocol/src ./platform/protocol/src
COPY platform/protocol/schemas ./platform/protocol/schemas
COPY platform/workflow-core/src ./platform/workflow-core/src
COPY native-host ./native-host
COPY manifest.json ./extension/manifest.json
COPY src ./extension/src
COPY ui ./extension/ui
COPY --from=native-build /native/x11-inputd/war-x11-inputd /usr/local/bin/war-x11-inputd
COPY --from=native-build /native/x11-inputd/war-cloakbrowser-sandbox-launcher /usr/local/bin/war-cloakbrowser-sandbox-launcher
COPY --from=native-build /native/x11-inputd/war-native-bridge-policy-probe /usr/local/bin/war-native-bridge-policy-probe
COPY --from=native-build /native/x11-inputd/war-native-host-launcher /usr/local/bin/war-native-host
COPY --from=xclip-sensitive-build /build/xclip/xclip /usr/local/bin/war-xclip-sensitive
COPY --from=xclip-sensitive-build /build/xclip/COPYING /usr/share/licenses/war-xclip-sensitive/LICENSE
COPY --from=xclip-sensitive-build /tmp/xclip.tar.gz /usr/share/doc/war-xclip-sensitive/xclip-2c3b811002b35d3be7f39cc1145dd06bdb32e31c.tar.gz
COPY platform/browser-agent/THIRD_PARTY_NOTICES.md /usr/share/doc/war-xclip-sensitive/NOTICE
COPY platform/browser-agent/xclip-source.json /usr/share/doc/war-xclip-sensitive/SOURCE.json
COPY platform/browser-agent/SBOM.spdx.json /usr/share/doc/war-xclip-sensitive/SBOM.spdx.json
COPY scripts/ci/generate-image-sbom.mjs /usr/local/lib/war/generate-image-sbom.mjs
COPY platform/browser-agent/cloakbrowser-provenance.json /usr/share/doc/war-browser-agent/cloakbrowser-provenance.json
COPY platform/browser-agent/THIRD_PARTY_NOTICES.md /usr/share/doc/war-browser-agent/THIRD_PARTY_NOTICES.md
COPY --from=cloakbrowser-build /opt/war/cloakbrowser /opt/war/cloakbrowser

RUN mkdir -p /etc/chromium/native-messaging-hosts /etc/opt/chrome/native-messaging-hosts \
    && printf '%s\n' \
      '{' \
      '  "name": "com.web_action_recorder.native_bridge",' \
      '  "description": "Web Action Recorder container native bridge",' \
      '  "path": "/usr/local/bin/war-native-host",' \
      '  "type": "stdio",' \
      '  "allowed_origins": ["chrome-extension://edoicfpldmlabgdalemfgflpldiijdmm/"]' \
      '}' \
      > /etc/chromium/native-messaging-hosts/com.web_action_recorder.native_bridge.json \
    && cp /etc/chromium/native-messaging-hosts/com.web_action_recorder.native_bridge.json /etc/opt/chrome/native-messaging-hosts/com.web_action_recorder.native_bridge.json

RUN useradd --create-home --shell /usr/sbin/nologin war \
    && mkdir -p /data/device /data/chromium-profile /data/downloads /data/uploads /data/logs /run/war \
    && rm -f /opt/war/cloakbrowser/chromium-${CLOAKBROWSER_VERSION}/chrome-sandbox \
    && chown -R root:root /app /opt/war/cloakbrowser /usr/local/lib/war /usr/share/doc/war-browser-agent /usr/local/bin/war-native-host /usr/local/bin/war-x11-inputd /usr/local/bin/war-xclip-sensitive /usr/local/bin/war-cloakbrowser-sandbox-launcher /usr/local/bin/war-native-bridge-policy-probe \
    && chmod -R a-w /app /opt/war/cloakbrowser /usr/local/lib/war /usr/share/doc/war-browser-agent \
    && chmod 0555 /usr/local/bin/war-cloakbrowser-sandbox-launcher \
    && chmod 0555 /usr/local/bin/war-native-host \
    && chmod 0555 /usr/local/bin/war-native-bridge-policy-probe \
    && chown -R war:war /data /run/war \
    && chmod 0700 /run/war \
    && find / -xdev \( -type f -o -type d \) \( -perm /4000 -o -perm /2000 \) -exec chmod a-s {} + \
    && test -x /opt/war/cloakbrowser/chromium-${CLOAKBROWSER_VERSION}/chrome \
    && test -x /usr/local/bin/war-cloakbrowser-sandbox-launcher \
    && test -z "$(find /usr/local/bin/war-cloakbrowser-sandbox-launcher -perm /222 -print -quit)" \
    && test -x /usr/local/bin/war-native-host \
    && test -z "$(find /usr/local/bin/war-native-host -perm /222 -print -quit)" \
    && test -x /usr/local/bin/war-native-bridge-policy-probe \
    && test -z "$(find /usr/local/bin/war-native-bridge-policy-probe -perm /222 -print -quit)" \
    && test -x /usr/local/bin/war-xclip-sensitive \
    && test -s /usr/share/licenses/war-xclip-sensitive/LICENSE \
    && test -s /usr/share/doc/war-xclip-sensitive/NOTICE \
    && test -s /usr/share/doc/war-xclip-sensitive/SOURCE.json \
    && test -s /usr/share/doc/war-xclip-sensitive/SBOM.spdx.json \
    && test -s /usr/local/lib/war/generate-image-sbom.mjs \
    && test -s /usr/share/doc/war-browser-agent/cloakbrowser-provenance.json \
    && test -s /usr/share/doc/war-browser-agent/THIRD_PARTY_NOTICES.md \
    && test -z "$(find /usr/local/lib/war /usr/share/doc/war-browser-agent -xdev \( -type f -o -type d \) -perm /222 -print -quit)" \
    && echo "${XCLIP_ARCHIVE_SHA256}  /usr/share/doc/war-xclip-sensitive/xclip-${XCLIP_COMMIT}.tar.gz" | sha256sum --check --status \
    && test -z "$(find /opt/war/cloakbrowser -xdev \( -type f -o -type d \) -perm /222 -print -quit)" \
    && test ! -e /opt/war/cloakbrowser/chromium-${CLOAKBROWSER_VERSION}/chrome-sandbox \
    && test -z "$(find / -xdev \( -type f -o -type d \) \( -perm /4000 -o -perm /2000 \) -print -quit)"

COPY platform/browser-agent/docker-entrypoint.sh /usr/local/bin/browser-agent-entrypoint
RUN chmod +x /usr/local/bin/browser-agent-entrypoint

USER war
EXPOSE 3766
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/browser-agent-entrypoint"]
CMD ["node", "platform/browser-agent/src/agent.js"]
