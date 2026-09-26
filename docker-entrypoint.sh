#!/bin/sh
# The bot runs as the unprivileged user `node`: a flaw in the code that decodes
# camera frames (sharp, ONNX Runtime) must not hand out root in the container.
# This script alone starts as root, to make /data (model cache, evidence)
# writable by `node` — recursively only the first time, when the volume still
# belongs to root — then hands over.
set -e

DATA_DIR="${CAM_GUARD_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/models"
  if [ "$(stat -c %U "$DATA_DIR")" != "node" ]; then
    chown -R node:node "$DATA_DIR"
  fi
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
