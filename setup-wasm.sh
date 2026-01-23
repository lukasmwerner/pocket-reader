#!/bin/bash
# Setup script for Pocket Reader WASM TTS
# This script clones the pocket-tts repo, applies necessary patches, and builds the WASM package

set -e

echo "🚀 Setting up Pocket Reader WASM TTS..."

# Check for required tools
if ! command -v cargo &> /dev/null; then
    echo "❌ Error: Rust/Cargo not found. Please install Rust from https://rustup.rs"
    exit 1
fi

if ! command -v wasm-pack &> /dev/null; then
    echo "📦 Installing wasm-pack..."
    cargo install wasm-pack
fi

# Create temp directory
TEMP_DIR=$(mktemp -d)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "📥 Cloning pocket-tts repository..."
git clone --depth 1 https://github.com/babybirdprd/pocket-tts.git "$TEMP_DIR/pocket-tts"

echo "🔧 Applying patches for WASM compatibility..."

# Patch 1: Add getrandom 0.2 with js feature for WASM compatibility
CARGO_FILE="$TEMP_DIR/pocket-tts/crates/pocket-tts/Cargo.toml"
cat "$CARGO_FILE" | sed '/\[target.*wasm32.*dependencies\]/a\
getrandom_02 = { package = "getrandom", version = "0.2", features = ["js"] }
' > "$CARGO_FILE.new"
mv "$CARGO_FILE.new" "$CARGO_FILE"

# Patch 2: Fix tokenizer Arc issue in text.rs
TEXT_RS="$TEMP_DIR/pocket-tts/crates/pocket-tts/src/conditioners/text.rs"
sed -i '' 's/Ok(Self { tokenizer, embed })/Ok(Self { tokenizer: std::sync::Arc::new(tokenizer), embed })/g' "$TEXT_RS" 2>/dev/null || \
sed -i 's/Ok(Self { tokenizer, embed })/Ok(Self { tokenizer: std::sync::Arc::new(tokenizer), embed })/g' "$TEXT_RS"

echo "🔨 Building WASM package (this may take a few minutes)..."
wasm-pack build --target web --out-dir "$TEMP_DIR/pocket-tts/crates/pocket-tts/pkg" "$TEMP_DIR/pocket-tts/crates/pocket-tts" -- --features wasm

# Copy files to extension
echo "📁 Copying WASM files to extension..."
mkdir -p "$SCRIPT_DIR/extension/wasm"
cp "$TEMP_DIR/pocket-tts/crates/pocket-tts/pkg/pocket_tts.js" "$SCRIPT_DIR/extension/wasm/"
cp "$TEMP_DIR/pocket-tts/crates/pocket-tts/pkg/pocket_tts_bg.wasm" "$SCRIPT_DIR/extension/wasm/"

# Clean up
rm -rf "$TEMP_DIR"

echo "✅ WASM setup complete!"
echo ""
echo "Files created:"
ls -lh "$SCRIPT_DIR/extension/wasm/"*.js "$SCRIPT_DIR/extension/wasm/"*.wasm
echo ""
echo "Next steps:"
echo "1. Open Chrome and go to chrome://extensions"
echo "2. Enable 'Developer mode'"
echo "3. Click 'Load unpacked' and select the 'extension' folder"
echo "4. Visit any web page and click the Pocket Reader icon"
echo ""
echo "Note: On first use, the extension will download the TTS model (~150MB) from HuggingFace."
