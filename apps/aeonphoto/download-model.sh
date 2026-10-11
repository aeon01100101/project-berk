#!/bin/sh
# download-model.sh — fetch an SD 1.5 checkpoint for AeonPhoto's bundled
# stable-diffusion.cpp server. Uses resumable curl (-C -) so interrupted
# downloads can be restarted with the same command.
#
# Model: stable-diffusion-v1-5 v1-5-pruned-emaonly.safetensors (~4 GB)
# License: CreativeML Open RAIL-M (https://huggingface.co/spaces/CompVis/stable-diffusion-license)
#   -> research + commercial use allowed with the license's use restrictions
#      (no illegal/harmful use, etc.). Read the license before redistributing.
set -e
MODEL_URL="${1:-https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors}"
OUT_DIR="${2:-$HOME/.local/share/aeonphoto/models}"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/v1-5-pruned-emaonly.safetensors"
echo "Downloading SD 1.5 to: $OUT"
echo "(resumable — re-run this script if it gets interrupted)"
curl -L -C - --retry 5 --retry-delay 5 -o "$OUT" "$MODEL_URL"
echo "Done. Start the backend with:"
echo "  sd-server -m \"$OUT\" --listen-ip 127.0.0.1 --listen-port 1234"
echo "(or drop the model into ~/.local/share/aeonphoto/models/ and let AeonPhoto start its bundled server itself)"
