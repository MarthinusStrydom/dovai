#!/bin/sh
set -eu

REPO="MarthinusStrydom/dovai"
INSTALL_DIR="/usr/local/bin"
BINARY="dovai"

# Allow overriding version: ./install.sh v0.2.0
VERSION="${1:-latest}"

main() {
    detect_platform
    set_download_url
    download_binary
    install_binary
    echo ""
    echo "dovai installed successfully! Run 'dovai' to get started."
}

detect_platform() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Darwin) OS_NAME="darwin" ;;
        Linux)  OS_NAME="linux" ;;
        *)      error "Unsupported operating system: $OS" ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH_NAME="x86_64" ;;
        arm64|aarch64) ARCH_NAME="arm64" ;;
        *)             error "Unsupported architecture: $ARCH" ;;
    esac

    if [ "$OS_NAME" = "linux" ] && [ "$ARCH_NAME" = "arm64" ]; then
        error "Linux arm64 is not yet supported. Please use x86_64."
    fi

    ASSET_NAME="dovai-${OS_NAME}-${ARCH_NAME}"
    echo "Detected platform: ${OS_NAME}/${ARCH_NAME}"
}

set_download_url() {
    if [ "$VERSION" = "latest" ]; then
        URL="https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"
    else
        URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET_NAME}"
    fi
}

download_binary() {
    TMPDIR="$(mktemp -d)"
    trap 'rm -rf "$TMPDIR"' EXIT

    echo "Downloading ${ASSET_NAME}..."

    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$URL" -o "${TMPDIR}/${BINARY}"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "${TMPDIR}/${BINARY}" "$URL"
    else
        error "curl or wget is required to download dovai"
    fi

    chmod +x "${TMPDIR}/${BINARY}"
}

install_binary() {
    echo "Installing to ${INSTALL_DIR}/${BINARY}..."

    if [ -w "$INSTALL_DIR" ]; then
        mv "${TMPDIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
    else
        echo "Permission needed to install to ${INSTALL_DIR} — using sudo"
        sudo mv "${TMPDIR}/${BINARY}" "${INSTALL_DIR}/${BINARY}"
    fi
}

error() {
    echo "Error: $1" >&2
    exit 1
}

main
