// Link sprite palette preview renderer. Uses the same 4bpp tile and 15-color row model as ZSPR files.

// SNES 4bpp tiles are 8x8 pixels stored in 32 planar bytes.
const BYTES_PER_TILE = 32;
// Every Link pose piece is assembled from hardware-sized 8x8 tiles.
const TILE_SIZE = 8;
// Link's 0x7000-byte sheet is arranged as 16 tiles per row.
const TILES_PER_ROW = 16;
// Palette words may use bit 15 for storage, but SNES BGR555 colors only use the low 15 bits.
const SNES_COLOR_MASK = 0x7fff;
// Padding keeps cropped previews from touching the canvas edge.
const PREVIEW_PADDING = 4;

// The default preview pose mirrors ZSpriteTools' first "Stand" frame without shield-only tiles.
const PREVIEW_POSE = [
  { row: "A", col: 0, pos: [-2, -1], size: "FULL" },
  { row: "B", col: 0, pos: [-1, 7], size: "FULL" },
];

// Draw shapes are copied from ZSpriteTools' TileDrawType handling for player sprite pieces.
const DRAW_SHAPES = {
  FULL: [[0, 0], [1, 0], [0, 1], [1, 1]],
  TOP_HALF: [[0, 0], [1, 0]],
  BOTTOM_HALF: [[0, 1], [1, 1]],
  RIGHT_HALF: [[1, 0], [1, 1]],
  LEFT_HALF: [[0, 0], [0, 1]],
  TOP_RIGHT: [[1, 0]],
  TOP_LEFT: [[0, 0]],
  BOTTOM_RIGHT: [[1, 1]],
  BOTTOM_LEFT: [[0, 1]],
  TALL_8X24: [[0, 0], [0, 1], [0, 2]],
  WIDE_24X8: [[0, 0], [1, 0], [2, 0]],
  LARGE_16X24: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]],
  LARGE_32X24: [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1], [0, 2], [1, 2], [2, 2], [3, 2]],
};

// Creates the preview UI and returns methods the palette editor can call as state changes.
export function createLinkSpritePreview(snapshot, editorState) {
  const element = document.createElement("section");
  element.className = "link-sprite-preview";
  element.innerHTML = `
    <div class="link-sprite-preview-heading">
      <h3>Sprite previews</h3>
      <p class="link-sprite-preview-status">Loading sprite preview...</p>
    </div>
    <div class="link-sprite-preview-grid"></div>
  `;

  const status = element.querySelector(".link-sprite-preview-status");
  const grid = element.querySelector(".link-sprite-preview-grid");
  const cards = snapshot.rows.map((row) => buildPreviewCard(row));

  for (const card of cards) {
    grid.append(card.element);
  }

  return {
    element,
    async load(helpers) {
      await loadPreviewPixels(helpers, editorState, status);
      this.render();
    },
    render() {
      renderPreviewCards(cards, snapshot, editorState);
    },
  };
}

// Builds one labeled canvas for a single armor/effect palette row.
function buildPreviewCard(row) {
  const element = document.createElement("section");
  element.className = "link-sprite-preview-card";
  element.innerHTML = `<h4>${row.label}</h4><canvas aria-label="${row.label} sprite preview"></canvas>`;
  return {
    element,
    row,
    canvas: element.querySelector("canvas"),
  };
}

// Reads the backend's best available Link pixels, preferring active ZSPR over compiled assets.
async function loadPreviewPixels(helpers, editorState, status) {
  try {
    const preview = await helpers.call("read_link_sprite_preview", {
      projectPath: helpers.state.selectedPath,
    });
    editorState.previewPixels = Uint8Array.from(preview.pixel_data ?? []);
    status.textContent = `${preview.label} (${preview.source})`;
  } catch (error) {
    editorState.previewPixels = null;
    status.textContent = `Preview unavailable: ${error}`;
  }
}

// Renders every preview canvas from current editor values and cached Link pixels.
function renderPreviewCards(cards, snapshot, editorState) {
  if (!editorState.previewPixels) {
    return;
  }

  for (const card of cards) {
    const paletteWords = editorState.values.slice(card.row.start, card.row.start + snapshot.row_length);
    renderPose(card.canvas, editorState.previewPixels, paletteWords);
  }
}

// Renders the configured pose into one canvas using the supplied 15-color palette row.
function renderPose(canvas, pixels, paletteWords) {
  const bounds = measurePose(PREVIEW_POSE);
  const width = bounds.right - bounds.left + PREVIEW_PADDING * 2;
  const height = bounds.bottom - bounds.top + PREVIEW_PADDING * 2;
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  const palette = paletteWords.map(snesWordToColor);

  for (const piece of [...PREVIEW_POSE].reverse()) {
    drawPiece(image, pixels, piece, palette, bounds);
  }

  context.putImageData(image, 0, 0);
}

// Measures the pose so canvases crop tightly around the drawn Link tiles with stable padding.
function measurePose(pose) {
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };

  for (const piece of pose) {
    const shape = DRAW_SHAPES[piece.size] ?? [];
    const maxTileX = Math.max(...shape.map(([x]) => x));
    const maxTileY = Math.max(...shape.map(([, y]) => y));
    bounds.left = Math.min(bounds.left, piece.pos[0]);
    bounds.top = Math.min(bounds.top, piece.pos[1]);
    bounds.right = Math.max(bounds.right, piece.pos[0] + (maxTileX + 1) * TILE_SIZE);
    bounds.bottom = Math.max(bounds.bottom, piece.pos[1] + (maxTileY + 1) * TILE_SIZE);
  }

  return bounds;
}

// Draws one sprite piece by expanding its ZSpriteTools row/column/shape into 8x8 tile draws.
function drawPiece(image, pixels, piece, palette, bounds) {
  const shape = DRAW_SHAPES[piece.size] ?? [];
  const baseTile = baseTileIndex(piece.row, piece.col);

  for (const [tileX, tileY] of shape) {
    const tileIndex = baseTile + tileX + tileY * TILES_PER_ROW;
    const destX = piece.pos[0] - bounds.left + PREVIEW_PADDING + tileX * TILE_SIZE;
    const destY = piece.pos[1] - bounds.top + PREVIEW_PADDING + tileY * TILE_SIZE;
    drawTile(image, pixels, tileIndex, destX, destY, palette);
  }
}

// Converts a ZSpriteTools row name and column into the top-left tile index for a 16x16 piece.
function baseTileIndex(rowName, column) {
  const row = rowIndex(rowName);
  return column * 2 + row * 2 * TILES_PER_ROW;
}

// Maps ZSpriteTools row labels A-Z, AA, and AB onto the 56-row Link tile sheet.
function rowIndex(rowName) {
  if (rowName === "AA") {
    return 26;
  }
  if (rowName === "AB") {
    return 27;
  }
  return rowName.charCodeAt(0) - "A".charCodeAt(0);
}

// Decodes one SNES 4bpp tile and writes non-transparent pixels into the output image.
function drawTile(image, pixels, tileIndex, destX, destY, palette) {
  const tileOffset = tileIndex * BYTES_PER_TILE;

  if (tileOffset + BYTES_PER_TILE > pixels.length) {
    return;
  }

  for (let y = 0; y < TILE_SIZE; y += 1) {
    const planeA = pixels[tileOffset + y * 2];
    const planeB = pixels[tileOffset + y * 2 + 1];
    const planeC = pixels[tileOffset + 16 + y * 2];
    const planeD = pixels[tileOffset + 16 + y * 2 + 1];

    for (let x = 0; x < TILE_SIZE; x += 1) {
      const bit = 7 - x;
      const colorIndex =
        ((planeA >> bit) & 1) |
        (((planeB >> bit) & 1) << 1) |
        (((planeC >> bit) & 1) << 2) |
        (((planeD >> bit) & 1) << 3);

      if (colorIndex > 0) {
        setPixel(image, destX + x, destY + y, palette[colorIndex - 1]);
      }
    }
  }
}

// Converts a SNES BGR555 palette word into browser RGBA channel values.
function snesWordToColor(word) {
  const colorWord = word & SNES_COLOR_MASK;
  return {
    red: snesChannelToByte(colorWord & 0x1f),
    green: snesChannelToByte((colorWord >> 5) & 0x1f),
    blue: snesChannelToByte((colorWord >> 10) & 0x1f),
    alpha: 255,
  };
}

// Expands one 5-bit SNES channel to 8-bit precision by bit replication.
function snesChannelToByte(value) {
  return (value << 3) | (value >> 2);
}

// Writes one RGBA pixel into an ImageData buffer if the destination is in bounds.
function setPixel(image, x, y, color) {
  if (!color || x < 0 || y < 0 || x >= image.width || y >= image.height) {
    return;
  }

  const index = (y * image.width + x) * 4;
  image.data[index] = color.red;
  image.data[index + 1] = color.green;
  image.data[index + 2] = color.blue;
  image.data[index + 3] = color.alpha;
}
