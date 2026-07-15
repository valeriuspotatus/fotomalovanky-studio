# Fotomalovanky studio — always-on container image for Render (or any Docker host).
#
# The Playwright base image carries Node 20 + a matching Chromium + every system library that both the
# PDF builder (the `playwright` dep) and the WhatsApp client (whatsapp-web.js -> puppeteer, launched
# with --no-sandbox) need. Pinned to the playwright dependency version so the preinstalled browser
# matches what the app drives.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install deps first so this layer caches unless the lockfile changes. whatsapp-web.js pulls puppeteer,
# which downloads its own Chromium during install; the base image already carries Playwright's browser
# for the builder.
COPY package.json package-lock.json ./
RUN npm ci

# App source only — .dockerignore whitelists src + manifests, so no secrets, customer data, node_modules,
# or bulky local reference dirs can enter the image.
COPY . .

# Render injects $PORT and expects a 0.0.0.0 bind (HOST). Locally the app still defaults to
# 127.0.0.1:4173 when these are unset.
#   - config.json arrives as a Render Secret File; FMA_CONFIG points the loader at it.
#   - STUDIO_USER / STUDIO_PASS turn on the login gate (set them in the Render env — the public URL
#     has no other auth).
#   - Data dirs (WhatsApp session, inbox/outbox, creatives, blog, autopilot) must point under the
#     mounted persistent disk in the cloud config.json, or they vanish on redeploy.
ENV HOST=0.0.0.0 \
    NODE_ENV=production

CMD ["node", "src/ui/server.js", "--no-open"]
