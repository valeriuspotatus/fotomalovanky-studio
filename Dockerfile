# Fotomalovanky studio — always-on container image for Render (or any Docker host).
#
# The Playwright base image carries Node 20 + every system library the PDF builder (the `playwright`
# dep) needs to drive headless Chromium. The tag MUST match the `playwright` version in
# package-lock.json — a mismatch means the bundled browser isn't the build the app drives, and the
# builder fails with "Executable doesn't exist".
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# Install deps first so this layer caches unless the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci
# Belt-and-suspenders: install the exact Chromium the INSTALLED playwright wants, so the builder's
# browser can never drift out of sync with the npm package even if the base tag lags. Fast no-op when
# the base image already carries the matching build.
RUN npx playwright install chromium

# App source only — .dockerignore whitelists src + manifests, so no secrets, customer data, node_modules,
# or bulky local reference dirs can enter the image.
COPY . .

# Render injects $PORT and expects a 0.0.0.0 bind (HOST). Locally the app still defaults to
# 127.0.0.1:4173 when these are unset.
#   - config.json arrives as a Render Secret File; FMA_CONFIG points the loader at it.
#   - STUDIO_OPERATOR_PASS_HASH / STUDIO_PRINTER_PASS_HASH hold the per-person passwords — one scrypt
#     hash per ROLE, generated with `node src/auth/credentials.js <password>` and pasted into the
#     Render env. Keyed by role, not username, so renaming an account never locks it out. The hashes
#     live ONLY here, never in config.json and never on the mounted disk (KTD1) — the disk holds
#     usernames and avatars only. BOTH must be set: with neither, the app refuses to start at all on
#     this image, because HOST=0.0.0.0 below would otherwise serve the whole studio ungated.
#   - Data dirs (inbox/outbox, creatives, blog, autopilot, accounts) must point under the mounted
#     persistent disk in the cloud config.json, or they vanish on redeploy.
ENV HOST=0.0.0.0 \
    NODE_ENV=production

CMD ["node", "src/ui/server.js", "--no-open"]
