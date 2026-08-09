FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ARG CHROME_VERSION=151.0.7922.108-1
ARG CHROME_DEB_SHA256=bfb6e6d345055eb481a50db423256fa2732ce010f785a56c327e213a638efdef
ARG SUNSHINE_VERSION=0.23.1
ARG SUNSHINE_DEB_SHA256=b60f9c829b8c08a05a0de34c82c4a720c773fd6941d889eaceb8b3df9f57286d

LABEL org.opencontainers.image.title="WAR disposable interactive Chrome pilot" \
      org.opencontainers.image.description="Human-only Chrome plus Sunshine pilot; not the managed CloakBrowser runtime" \
      com.web-action-recorder.pilot="disposable-human-only"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xvfb x11-utils \
    && curl --fail --location --retry 3 --output /tmp/google-chrome.deb \
      "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
    && echo "${CHROME_DEB_SHA256}  /tmp/google-chrome.deb" | sha256sum --check --status \
    && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
    && test "$(dpkg-query -W -f='${Version}' google-chrome-stable)" = "${CHROME_VERSION}" \
    && rm -f /tmp/google-chrome.deb \
    && curl --fail --location --retry 3 --output /tmp/sunshine.deb \
      "https://github.com/LizardByte/Sunshine/releases/download/v${SUNSHINE_VERSION}/sunshine-debian-bookworm-amd64.deb" \
    && echo "${SUNSHINE_DEB_SHA256}  /tmp/sunshine.deb" | sha256sum --check --status \
    && apt-get install -y --no-install-recommends /tmp/sunshine.deb \
    && rm -f /tmp/sunshine.deb \
    && rm -rf /var/lib/apt/lists/*

COPY platform/interactive-browser/pilot-config.mjs /opt/war/interactive-browser/pilot-config.mjs
COPY platform/interactive-browser/sunshine.conf /etc/sunshine/sunshine.conf
COPY platform/interactive-browser/entrypoint.sh /usr/local/bin/war-interactive-browser

RUN chmod 0755 /usr/local/bin/war-interactive-browser \
    && useradd --create-home --shell /usr/sbin/nologin warpilot \
    && mkdir -p /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && mkdir -p /data/chrome-profile \
    && chown -R warpilot:warpilot /data \
    && chmod 0700 /data/chrome-profile

USER warpilot
ENTRYPOINT ["/usr/local/bin/war-interactive-browser"]
