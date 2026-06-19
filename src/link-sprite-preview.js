// Link sprite palette preview renderer. Uses ZSPR's 4bpp tile layout and animation step data.

// SNES 4bpp tiles are 8x8 pixels stored in 32 planar bytes.
const BYTES_PER_TILE = 32;
// Every Link pose piece is assembled from hardware-sized 8x8 tiles.
const TILE_SIZE = 8;
// Link's 0x7000-byte sheet is arranged as 16 tiles per row.
const TILES_PER_ROW = 16;
// Palette words may use bit 15 for storage, but SNES BGR555 colors only use the low 15 bits.
const SNES_COLOR_MASK = 0x7fff;
// ZSpriteTools drives its animation preview with a 17ms timer.
const ANIMATION_TICK_MS = 17;
// Padding keeps cropped previews from touching the canvas edge.
const PREVIEW_PADDING = 4;
// PlayerSprite.DrawTile skips anything after row AB, including shields and equipment.
const PLAYER_ROW_PATTERN = /^(?:[A-Z]|AA|AB)$/;

// The default inline preview mirrors ZSpriteTools' "Walk" animation without shield-only rows.
const WALK_ANIMATION = [
  {
    length: 2,
    sprites: [
      { row: "A", col: 0, pos: [-2, -1], size: "FULL" },
      { row: "B", col: 0, pos: [-1, 7], size: "FULL" },
      { row: "SHIELD", col: 1, pos: [5, 2], size: "FULL" },
    ],
  },
  {
    length: 3,
    sprites: [
      { row: "A", col: 0, pos: [-2, -2], size: "FULL" },
      { row: "B", col: 1, pos: [-1, 7], size: "FULL" },
      { row: "SHIELD", col: 1, pos: [5, 0], size: "FULL" },
    ],
  },
  {
    length: 2,
    sprites: [
      { row: "K", col: 3, pos: [-1, -2], size: "FULL" },
      { row: "B", col: 2, pos: [-1, 7], size: "FULL" },
      { row: "SHIELD", col: 1, pos: [5, 0], size: "FULL" },
    ],
  },
  {
    length: 2,
    sprites: [
      { row: "K", col: 4, pos: [-2, -1], size: "FULL" },
      { row: "Q", col: 7, pos: [-1, 7], size: "FULL" },
      { row: "SHIELD", col: 1, pos: [5, 1], size: "FULL" },
    ],
  },
  {
    length: 2,
    sprites: [
      { row: "A", col: 0, pos: [-2, -1], size: "FULL" },
      { row: "S", col: 4, pos: [-1, 7], size: "FULL" },
      { row: "SHIELD", col: 1, pos: [5, 2], size: "FULL" },
    ],
  },
  {
    length: 3,
    sprites: [
      { row: "A", col: 0, pos: [-2, -2], size: "FULL" },
      { row: "R", col: 6, pos: [-1, 7], size: "FULL" },
      { row: "SHIELD", col: 1, pos: [5, 1], size: "FULL" },
    ],
  },
  {
    length: 2,
    sprites: [
      { row: "K", col: 3, pos: [-1, -2], size: "FULL" },
      { row: "R", col: 7, pos: [-1, 7], size: "FULL" },
      { row: "SHIELD", col: 1, pos: [5, 0], size: "FULL" },
    ],
  },
  {
    length: 1,
    sprites: [
      { row: "K", col: 4, pos: [-1, -1], size: "FULL" },
      { row: "S", col: 3, pos: [-1, 7], size: "FULL" },
      { row: "SHIELD", col: 1, pos: [5, 1], size: "FULL" },
    ],
  },
];

// Draw shapes mirror ZSpriteTools' TileDrawType tile selection and temp-bitmap placement.
const DRAW_SHAPES = {
  FULL: [
    [0, 0, 0, 0],
    [1, 0, 1, 0],
    [0, 1, 0, 1],
    [1, 1, 1, 1],
  ],
  TOP_HALF: [
    [0, 0, 0, 0],
    [1, 0, 1, 0],
  ],
  BOTTOM_HALF: [
    [0, 1, 0, 0],
    [1, 1, 1, 0],
  ],
  RIGHT_HALF: [
    [1, 0, 0, 0],
    [1, 1, 0, 1],
  ],
  LEFT_HALF: [
    [0, 0, 0, 0],
    [0, 1, 0, 1],
  ],
  TOP_RIGHT: [[1, 0, 0, 0]],
  TOP_LEFT: [[0, 0, 0, 0]],
  BOTTOM_RIGHT: [[1, 1, 0, 0]],
  BOTTOM_LEFT: [[0, 1, 0, 0]],
  TALL_8X24: [
    [0, 0, 0, 0],
    [0, 1, 0, 1],
    [0, 2, 0, 2],
  ],
  WIDE_24X8: [
    [0, 0, 0, 0],
    [1, 0, 1, 0],
    [2, 0, 2, 0],
  ],
  LARGE_16X24: [
    [0, 0, 0, 0],
    [1, 0, 1, 0],
    [0, 1, 0, 1],
    [1, 1, 1, 1],
    [0, 2, 0, 2],
    [1, 2, 1, 2],
  ],
  LARGE_32X24: [
    [0, 0, 0, 0],
    [1, 0, 1, 0],
    [2, 0, 2, 0],
    [3, 0, 3, 0],
    [0, 1, 0, 1],
    [1, 1, 1, 1],
    [2, 1, 2, 1],
    [3, 1, 3, 1],
    [0, 2, 0, 2],
    [1, 2, 1, 2],
    [2, 2, 2, 2],
    [3, 2, 3, 2],
  ],
};

const WALK_BOUNDS = measureAnimation(WALK_ANIMATION);
const WALK_TOTAL_LENGTH = sumAnimationLength(WALK_ANIMATION);

// Creates the preview controller used by the palette editor.
export function createLinkSpritePreview(snapshot, editorState, status) {
  const cards = [];
  let activeStepIndex = 0;
  let animationFrameId = null;
  let animationStartedAt = 0;
  let destroyed = false;

  const controller = {
    attachRow(row, container) {
      if (destroyed || !container) {
        return;
      }

      const card = buildPreviewCard(row);
      cards.push(card);
      container.append(card.canvas);
      renderPreviewCard(card, snapshot, editorState, activeStepIndex);
    },
    async load(helpers) {
      await loadPreviewPixels(helpers, editorState, status);

      if (destroyed) {
        return;
      }

      this.render();
      startAnimation();
    },
    render() {
      renderPreviewCards(cards, snapshot, editorState, activeStepIndex);
    },
    destroy() {
      destroyed = true;
      stopAnimation();
    },
  };

  function startAnimation() {
    if (!editorState.previewPixels || animationFrameId !== null || typeof window === "undefined") {
      return;
    }

    if (typeof window.requestAnimationFrame !== "function") {
      return;
    }

    animationStartedAt = browserNow();
    const animate = (time) => {
      const nextStepIndex = animationStepIndex(time - animationStartedAt);

      if (nextStepIndex !== activeStepIndex) {
        activeStepIndex = nextStepIndex;
        controller.render();
      }

      animationFrameId = window.requestAnimationFrame(animate);
    };
    animationFrameId = window.requestAnimationFrame(animate);
  }

  function stopAnimation() {
    if (animationFrameId === null || typeof window === "undefined") {
      animationFrameId = null;
      return;
    }

    if (typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(animationFrameId);
    }
    animationFrameId = null;
  }

  return controller;
}

// Builds one canvas for a single armor/effect palette row.
function buildPreviewCard(row) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", `${row.label} animated sprite preview`);

  return { row, canvas };
}

// Reads the backend's best available Link pixels, preferring active ZSPR over compiled assets.
async function loadPreviewPixels(helpers, editorState, status) {
  try {
    const preview = await helpers.call("read_link_sprite_preview", {
      projectPath: helpers.state.selectedPath,
    });
    const pixels = Uint8Array.from(preview.pixel_data ?? []);
    editorState.previewPixels = pixels.length ? pixels : null;
    setPreviewStatus(status, `${preview.label} (${preview.source})`);
  } catch (error) {
    editorState.previewPixels = null;
    setPreviewStatus(status, `Preview unavailable: ${error}`);
  }
}

// Renders every preview canvas from current editor values and cached Link pixels.
function renderPreviewCards(cards, snapshot, editorState, stepIndex) {
  for (const card of cards) {
    renderPreviewCard(card, snapshot, editorState, stepIndex);
  }
}

// Renders one row preview, or clears it while preview pixels are unavailable.
function renderPreviewCard(card, snapshot, editorState, stepIndex) {
  if (!editorState.previewPixels) {
    clearPreviewCanvas(card.canvas);
    return;
  }

  const rowStart = card.row.start;
  const paletteWords = editorState.values.slice(rowStart, rowStart + snapshot.row_length);
  renderAnimationStep(card.canvas, editorState.previewPixels, paletteWords, WALK_ANIMATION[stepIndex]);
}

// Renders one animation step into one canvas using the supplied 15-color palette row.
function renderAnimationStep(canvas, pixels, paletteWords, step) {
  const width = previewWidth();
  const height = previewHeight();
  setCanvasSize(canvas, width, height);

  const context = canvas.getContext("2d");

  if (!context) {
    return;
  }

  const image = context.createImageData(width, height);
  const palette = paletteWords.map(snesWordToColor);

  for (const piece of [...step.sprites].reverse()) {
    drawPiece(image, pixels, piece, palette, WALK_BOUNDS);
  }

  context.putImageData(image, 0, 0);
}

// Keeps empty previews sized consistently so layout does not jump while pixels load.
function clearPreviewCanvas(canvas) {
  const width = previewWidth();
  const height = previewHeight();
  setCanvasSize(canvas, width, height);

  const context = canvas.getContext("2d");

  if (context) {
    context.clearRect(0, 0, width, height);
  }
}

// Measures every drawable frame so the canvas stays stable throughout the animation.
function measureAnimation(animation) {
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };

  for (const step of animation) {
    for (const piece of step.sprites ?? []) {
      if (!isDrawablePlayerRow(piece.row)) {
        continue;
      }

      const dimensions = shapeDimensions(DRAW_SHAPES[piece.size]);

      if (!dimensions) {
        continue;
      }

      bounds.left = Math.min(bounds.left, piece.pos[0]);
      bounds.top = Math.min(bounds.top, piece.pos[1]);
      bounds.right = Math.max(bounds.right, piece.pos[0] + dimensions.width);
      bounds.bottom = Math.max(bounds.bottom, piece.pos[1] + dimensions.height);
    }
  }

  if (bounds.left === Infinity) {
    return { left: 0, top: 0, right: TILE_SIZE * 2, bottom: TILE_SIZE * 2 };
  }

  return bounds;
}

// Returns the drawn dimensions for a TileDrawType shape in pixels.
function shapeDimensions(shape) {
  if (!shape || shape.length === 0) {
    return null;
  }

  let maxDestX = 0;
  let maxDestY = 0;

  for (const [, , destX, destY] of shape) {
    maxDestX = Math.max(maxDestX, destX);
    maxDestY = Math.max(maxDestY, destY);
  }

  return {
    width: (maxDestX + 1) * TILE_SIZE,
    height: (maxDestY + 1) * TILE_SIZE,
  };
}

// Draws one sprite piece by expanding its ZSpriteTools row/column/shape into 8x8 tile draws.
function drawPiece(image, pixels, piece, palette, bounds) {
  if (!isDrawablePlayerRow(piece.row)) {
    return;
  }

  const shape = DRAW_SHAPES[piece.size] ?? [];
  const dimensions = shapeDimensions(shape);

  if (!dimensions) {
    return;
  }

  const baseTile = baseTileIndex(piece.row, piece.col);
  const pieceX = piece.pos[0] - bounds.left + PREVIEW_PADDING;
  const pieceY = piece.pos[1] - bounds.top + PREVIEW_PADDING;

  for (const [srcX, srcY, destX, destY] of shape) {
    const tileIndex = baseTile + srcX + srcY * TILES_PER_ROW;
    drawTile(image, pixels, tileIndex, pieceX, pieceY, destX, destY, dimensions, palette, piece.trans);
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

// Reports whether a ZSpriteTools row is one of PlayerSprite.DrawTile's drawable Link rows.
function isDrawablePlayerRow(rowName) {
  return PLAYER_ROW_PATTERN.test(rowName);
}

// Decodes one SNES 4bpp tile and writes non-transparent pixels into the output image.
function drawTile(image, pixels, tileIndex, pieceX, pieceY, destTileX, destTileY, dimensions, palette, flip) {
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
        const target = transformPixel(destTileX * TILE_SIZE + x, destTileY * TILE_SIZE + y, dimensions, flip);
        setPixel(image, pieceX + target.x, pieceY + target.y, palette[colorIndex - 1]);
      }
    }
  }
}

// Applies ZSpriteTools' temporary-bitmap flip semantics to one piece-local pixel.
function transformPixel(x, y, dimensions, flip) {
  const point = { x, y };

  if (flip === "Y_FLIP" || flip === "XY_FLIP") {
    point.x = dimensions.width - 1 - point.x;
  }

  if (flip === "X_FLIP" || flip === "XY_FLIP") {
    point.y = dimensions.height - 1 - point.y;
  }

  return point;
}

// Converts elapsed browser time into the weighted animation step index used by ZSpriteTools.
function animationStepIndex(elapsed) {
  const tick = Math.floor(elapsed / ANIMATION_TICK_MS) % WALK_TOTAL_LENGTH;
  let totalLength = 0;

  for (let index = 0; index < WALK_ANIMATION.length; index += 1) {
    totalLength += WALK_ANIMATION[index].length;

    if (tick < totalLength) {
      return index;
    }
  }

  return 0;
}

// Totals the per-step frame lengths from the source animation data.
function sumAnimationLength(animation) {
  return animation.reduce((total, step) => total + step.length, 0);
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

// Applies one size to the canvas backing store without triggering unnecessary clears.
function setCanvasSize(canvas, width, height) {
  if (canvas.width !== width) {
    canvas.width = width;
  }

  if (canvas.height !== height) {
    canvas.height = height;
  }
}

function previewWidth() {
  return WALK_BOUNDS.right - WALK_BOUNDS.left + PREVIEW_PADDING * 2;
}

function previewHeight() {
  return WALK_BOUNDS.bottom - WALK_BOUNDS.top + PREVIEW_PADDING * 2;
}

function browserNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

function setPreviewStatus(status, message) {
  if (status) {
    status.textContent = message;
  }
}
