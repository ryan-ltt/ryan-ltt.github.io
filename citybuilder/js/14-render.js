// ═══ citybuilder/js/14-render.js ══════════════════════════════════════
// Canvas rendering: pixel-art draw functions per tile type, LOD, day/night overlay, people/fires/particles, the rAF frame loop.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

// ── Pixel-art draw functions (all authored at 32×32, origin at top-left) ──────

// Grass shifts colour with the seasons: [base, light tufts, dark tufts]
const GRASS_PALETTES = {
  spring: ['#4caf50', '#66bb6a', '#388e3c'],
  summer: ['#66a94c', '#85c162', '#4a8a38'],
  autumn: ['#94964a', '#adaf62', '#6e7136'],
  winter: ['#cfd8dc', '#eceff1', '#a7bcc4'],
};

function grassPalette() { return GRASS_PALETTES[currentSeason()]; }

function drawGrass(x, y) {
  const pal = grassPalette();
  ctx.fillStyle = pal[0]; ctx.fillRect(x, y, BASE, BASE);
  ctx.fillStyle = pal[1];
  ctx.fillRect(x+4,  y+6,  4, 4);
  ctx.fillRect(x+20, y+14, 4, 4);
  ctx.fillRect(x+10, y+22, 4, 4);
  ctx.fillStyle = pal[2];
  ctx.fillRect(x+14, y+4,  2, 2);
  ctx.fillRect(x+26, y+18, 2, 2);
  ctx.fillRect(x+6,  y+27, 2, 2);
}

function drawWell(x, y) {
  const pal = grassPalette();
  ctx.fillStyle = pal[0]; ctx.fillRect(x, y, BASE, BASE);
  // Stone ring
  ctx.fillStyle = '#90a4ae';
  ctx.fillRect(x+8,  y+14, 16, 12);
  ctx.fillStyle = '#78909c';
  ctx.fillRect(x+8,  y+24, 16, 2);
  // Water
  ctx.fillStyle = '#4fc3f7';
  ctx.fillRect(x+11, y+16, 10, 7);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+12, y+17, 4, 2);
  // Posts and little roof
  ctx.fillStyle = '#5d4037';
  ctx.fillRect(x+8,  y+6, 2, 10);
  ctx.fillRect(x+22, y+6, 2, 10);
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(x+6,  y+4, 20, 3);
  ctx.fillStyle = '#6d4c41';
  ctx.fillRect(x+10, y+7, 12, 1); // crossbar
  // Bucket rope
  ctx.fillStyle = '#3e2723';
  ctx.fillRect(x+15, y+7, 1, 6);
  ctx.fillStyle = '#795548';
  ctx.fillRect(x+13, y+12, 5, 3);
}

function drawSchool(x, y) {
  // Red schoolhouse with a bell tower
  ctx.fillStyle = '#c62828'; ctx.fillRect(x+2, y+12, 28, 18);
  // Roof
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(x+4,  y+8,  24, 4);
  ctx.fillRect(x+8,  y+6,  16, 2);
  // Bell tower
  ctx.fillStyle = '#efebe9';
  ctx.fillRect(x+13, y+0,  6, 8);
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(x+12, y+0,  8, 2);
  ctx.fillStyle = '#ff8f00'; // bell
  ctx.fillRect(x+15, y+3,  2, 3);
  // Windows
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+5,  y+16, 6, 6);
  ctx.fillRect(x+21, y+16, 6, 6);
  ctx.fillStyle = '#1565c0';
  ctx.fillRect(x+7,  y+16, 2, 6);
  ctx.fillRect(x+23, y+16, 2, 6);
  // Door
  ctx.fillStyle = '#4e342e'; ctx.fillRect(x+13, y+22, 6, 8);
  // Chalkboard sign
  ctx.fillStyle = '#fff'; ctx.fillRect(x+13, y+14, 6, 4);
}

function drawRoad(x, y) {
  ctx.fillStyle = '#a1887f'; ctx.fillRect(x, y, BASE, BASE);
  ctx.fillStyle = '#bcaaa4';
  ctx.fillRect(x+2,  y+4,  6, 4);
  ctx.fillRect(x+18, y+16, 6, 4);
  ctx.fillRect(x+8,  y+24, 5, 3);
  ctx.fillStyle = '#795548';
  ctx.fillRect(x+12, y+6,  2, 2);
  ctx.fillRect(x+5,  y+18, 2, 2);
  ctx.fillRect(x+22, y+10, 2, 2);
  ctx.fillRect(x+16, y+26, 2, 2);
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(x,         y,         BASE, 2);
  ctx.fillRect(x,         y+BASE-2,  BASE, 2);
  ctx.fillRect(x,         y,         2,    BASE);
  ctx.fillRect(x+BASE-2,  y,         2,    BASE);
}

function drawHouse(x, y) {
  ctx.fillStyle = '#1e88e5'; ctx.fillRect(x+2, y+16, 28, 14);
  ctx.fillStyle = '#c62828';
  ctx.fillRect(x+14, y+4,  4,  2);
  ctx.fillRect(x+10, y+6,  12, 2);
  ctx.fillRect(x+6,  y+8,  20, 2);
  ctx.fillRect(x+4,  y+10, 24, 2);
  ctx.fillRect(x+2,  y+12, 28, 4);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+4,  y+18, 8, 6);
  ctx.fillRect(x+20, y+18, 8, 6);
  ctx.fillStyle = '#1565c0';
  ctx.fillRect(x+7,  y+18, 2, 6);
  ctx.fillRect(x+23, y+18, 2, 6);
  ctx.fillStyle = '#5d4037'; ctx.fillRect(x+12, y+22, 8, 8);
}

function drawRowHouse(x, y) {
  // Terracotta two-unit terrace
  ctx.fillStyle = '#e57373'; ctx.fillRect(x+2, y+14, 28, 16); // walls
  // Left unit roof
  ctx.fillStyle = '#b71c1c';
  ctx.fillRect(x+2,  y+8,  2,  6);
  ctx.fillRect(x+4,  y+6,  10, 2);
  ctx.fillRect(x+4,  y+8,  10, 6);
  ctx.fillRect(x+14, y+10, 2,  4);
  // Right unit roof
  ctx.fillRect(x+16, y+8,  2,  6);
  ctx.fillRect(x+18, y+6,  10, 2);
  ctx.fillRect(x+18, y+8,  10, 6);
  // Party wall line
  ctx.fillStyle = '#c62828'; ctx.fillRect(x+15, y+8, 2, 22);
  // Windows
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+4,  y+18, 6, 5);
  ctx.fillRect(x+22, y+18, 6, 5);
  ctx.fillStyle = '#1565c0';
  ctx.fillRect(x+7,  y+18, 1, 5);
  ctx.fillRect(x+25, y+18, 1, 5);
  // Doors
  ctx.fillStyle = '#5d4037';
  ctx.fillRect(x+6,  y+24, 4, 6);
  ctx.fillRect(x+22, y+24, 4, 6);
}

function drawApartment(x, y) {
  // Grey multi-storey block with window grid
  ctx.fillStyle = '#7e57c2'; ctx.fillRect(x+2, y+4, 28, 26); // main block
  ctx.fillStyle = '#512da8'; ctx.fillRect(x+2, y+2, 28, 4);  // parapet
  // Roof details
  ctx.fillStyle = '#9575cd';
  ctx.fillRect(x+4,  y+0, 4, 4);
  ctx.fillRect(x+14, y+0, 4, 4);
  ctx.fillRect(x+24, y+0, 4, 4);
  // Window grid — 3 columns × 3 rows
  ctx.fillStyle = '#e1f5fe';
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      ctx.fillRect(x+4 + col*9, y+7 + row*7, 6, 4);
    }
  }
  // Window dividers
  ctx.fillStyle = '#4527a0';
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      ctx.fillRect(x+7 + col*9, y+7 + row*7, 1, 4);
    }
  }
  // Door
  ctx.fillStyle = '#4a148c'; ctx.fillRect(x+13, y+24, 6, 6);
}

function drawShop(x, y) {
  ctx.fillStyle = '#ef6c00'; ctx.fillRect(x+2, y+4,  28, 10);
  ctx.fillStyle = '#e65100'; ctx.fillRect(x+2, y+2,  28, 4);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x+6, y+6,  20, 6);
  ctx.fillStyle = '#2e7d32';
  ctx.fillRect(x+13, y+7, 6, 2);
  ctx.fillRect(x+13, y+9, 6, 2);
  ctx.fillRect(x+15, y+6, 2, 6);
  ctx.fillStyle = '#2e7d32'; ctx.fillRect(x+2,  y+13, 28, 4);
  ctx.fillStyle = '#ffe082'; ctx.fillRect(x+2,  y+16, 28, 14);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+4,  y+18, 6, 6);
  ctx.fillRect(x+22, y+18, 6, 6);
  ctx.fillStyle = '#4e342e'; ctx.fillRect(x+12, y+22, 8, 8);
}

function drawPark(x, y) {
  ctx.fillStyle = '#66bb6a'; ctx.fillRect(x, y, BASE, BASE);
  ctx.fillStyle = '#2e7d32';
  ctx.fillRect(x+2,  y+2,  10, 10);
  ctx.fillRect(x+20, y+2,  10, 10);
  ctx.fillRect(x+2,  y+20, 10, 10);
  ctx.fillRect(x+20, y+20, 10, 10);
  ctx.fillStyle = '#795548';
  ctx.fillRect(x+6,  y+11, 2, 4);
  ctx.fillRect(x+24, y+11, 2, 4);
  ctx.fillRect(x+6,  y+29, 2, 4);
  ctx.fillRect(x+24, y+29, 2, 4);
  ctx.fillStyle = '#f44336'; ctx.fillRect(x+13, y+13, 6, 6);
  ctx.fillStyle = '#ffee58'; ctx.fillRect(x+15, y+15, 2, 2);
}

function drawFactory(x, y) {
  ctx.fillStyle = '#616161'; ctx.fillRect(x+2, y+14, 28, 16);
  ctx.fillStyle = '#424242';
  ctx.fillRect(x+4,  y+4, 8, 12);
  ctx.fillRect(x+20, y+8, 8, 8);
  ctx.fillStyle = '#b0bec5';
  ctx.fillRect(x+4,  y+2, 8, 4);
  ctx.fillRect(x+20, y+6, 8, 4);
  ctx.fillStyle = '#cfd8dc';
  ctx.fillRect(x+6,  y,   4, 4);
  ctx.fillRect(x+22, y+4, 4, 4);
  ctx.fillStyle = '#ffee58';
  ctx.fillRect(x+4,  y+18, 4, 4);
  ctx.fillRect(x+14, y+18, 4, 4);
  ctx.fillRect(x+24, y+18, 4, 4);
  ctx.fillStyle = '#212121'; ctx.fillRect(x+12, y+24, 8, 6);
}

function drawChurch(x, y) {
  ctx.fillStyle = '#e8e0d0'; ctx.fillRect(x+4, y+16, 24, 14);
  ctx.fillStyle = '#d5ccc0'; ctx.fillRect(x+12, y+8, 8, 10);
  ctx.fillStyle = '#b0a090';
  ctx.fillRect(x+14, y+4, 4, 2);
  ctx.fillRect(x+13, y+6, 6, 2);
  ctx.fillRect(x+12, y+8, 8, 2);
  ctx.fillStyle = '#ffee58';
  ctx.fillRect(x+15, y+4, 2, 6);
  ctx.fillRect(x+13, y+6, 6, 2);
  ctx.fillStyle = '#5d4037'; ctx.fillRect(x+13, y+22, 6, 8);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+5,  y+18, 4, 4);
  ctx.fillRect(x+23, y+18, 4, 4);
  ctx.fillStyle = '#7b1fa2'; ctx.fillRect(x+4, y+15, 24, 2);
}

function drawTownHall(x, y) {
  ctx.fillStyle = '#d7ccc8'; ctx.fillRect(x+1, y+14, 30, 16);
  ctx.fillStyle = '#bcaaa4'; ctx.fillRect(x+10, y+8, 12, 8);
  ctx.fillStyle = '#ff6f00';
  ctx.fillRect(x+15, y+2, 2, 2);
  ctx.fillRect(x+13, y+4, 6, 2);
  ctx.fillRect(x+11, y+6, 10, 2);
  ctx.fillStyle = '#ff6f00'; ctx.fillRect(x+15, y+2, 6, 4);
  ctx.fillStyle = '#fff';    ctx.fillRect(x+16, y+3, 2, 2);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+12, y+10, 3, 4);
  ctx.fillRect(x+21, y+10, 3, 4);
  ctx.fillStyle = '#efebe9';
  ctx.fillRect(x+3,  y+14, 3, 16);
  ctx.fillRect(x+26, y+14, 3, 16);
  ctx.fillStyle = '#5d4037'; ctx.fillRect(x+13, y+22, 6, 8);
  ctx.fillStyle = '#795548'; ctx.fillRect(x+14, y+20, 4, 4);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+5,  y+17, 5, 5);
  ctx.fillRect(x+22, y+17, 5, 5);
  ctx.fillStyle = '#ff6f00'; ctx.fillRect(x+1, y+13, 30, 2);
}

function drawTreeFarm(x, y) {
  // Brown soil base
  ctx.fillStyle = '#795548'; ctx.fillRect(x, y, BASE, BASE);
  ctx.fillStyle = '#6d4c41';
  ctx.fillRect(x+1, y+20, 30, 12);
  // Row lines in soil
  ctx.fillStyle = '#5d4037';
  ctx.fillRect(x+2, y+24, 28, 1);
  ctx.fillRect(x+2, y+28, 28, 1);
  // Three small trees
  // Tree trunks
  ctx.fillStyle = '#4e342e';
  ctx.fillRect(x+4,  y+14, 2, 7);
  ctx.fillRect(x+15, y+12, 2, 9);
  ctx.fillRect(x+26, y+14, 2, 7);
  // Tree canopies
  ctx.fillStyle = '#2e7d32';
  ctx.fillRect(x+1,  y+6,  8, 9);
  ctx.fillRect(x+12, y+4,  8, 9);
  ctx.fillRect(x+23, y+6,  8, 9);
  ctx.fillStyle = '#43a047';
  ctx.fillRect(x+2,  y+7,  6, 6);
  ctx.fillRect(x+13, y+5,  6, 6);
  ctx.fillRect(x+24, y+7,  6, 6);
}

function drawStoneFarm(x, y) {
  // Dark ground base
  ctx.fillStyle = '#546e7a'; ctx.fillRect(x, y, BASE, BASE);
  ctx.fillStyle = '#455a64';
  ctx.fillRect(x+1, y+18, 30, 13);
  // Quarry lines
  ctx.fillStyle = '#37474f';
  ctx.fillRect(x+2, y+22, 28, 1);
  ctx.fillRect(x+2, y+26, 28, 1);
  // Stone blocks arranged in cluster
  ctx.fillStyle = '#90a4ae';
  ctx.fillRect(x+3,  y+5,  10, 10);
  ctx.fillRect(x+19, y+7,  10, 10);
  ctx.fillRect(x+11, y+10, 8,  8);
  ctx.fillStyle = '#b0bec5';
  ctx.fillRect(x+4,  y+6,  5, 5);
  ctx.fillRect(x+20, y+8,  5, 5);
  ctx.fillRect(x+12, y+11, 4, 4);
  // Chisel marks
  ctx.fillStyle = '#78909c';
  ctx.fillRect(x+6,  y+8,  2, 1);
  ctx.fillRect(x+21, y+10, 2, 1);
}

function drawFarm(x, y) {
  // Golden field base
  ctx.fillStyle = '#f9a825'; ctx.fillRect(x, y, BASE, BASE);
  // Ploughed soil rows
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(x+1, y+18, 30, 13);
  ctx.fillStyle = '#795548';
  ctx.fillRect(x+2, y+21, 28, 1);
  ctx.fillRect(x+2, y+24, 28, 1);
  ctx.fillRect(x+2, y+27, 28, 1);
  // Wheat stalks (3 clusters)
  ctx.fillStyle = '#f57f17';
  ctx.fillRect(x+4,  y+10, 2, 9);
  ctx.fillRect(x+15, y+8,  2, 11);
  ctx.fillRect(x+26, y+10, 2, 9);
  // Wheat heads
  ctx.fillStyle = '#ffee58';
  ctx.fillRect(x+3,  y+6,  4, 5);
  ctx.fillRect(x+14, y+4,  4, 5);
  ctx.fillRect(x+25, y+6,  4, 5);
  ctx.fillStyle = '#fff9c4';
  ctx.fillRect(x+4,  y+7,  2, 3);
  ctx.fillRect(x+15, y+5,  2, 3);
  ctx.fillRect(x+26, y+7,  2, 3);
}

function drawWall(x, y) {
  // Stone curtain wall with battlements
  ctx.fillStyle = '#8a939c'; ctx.fillRect(x, y, BASE, BASE);
  // Crenellated top
  ctx.fillStyle = '#aab4bd';
  ctx.fillRect(x,    y, 6, 6);
  ctx.fillRect(x+9,  y, 6, 6);
  ctx.fillRect(x+18, y, 6, 6);
  ctx.fillRect(x+27, y, 5, 6);
  // Mortar courses
  ctx.fillStyle = '#6d767f';
  ctx.fillRect(x, y+10, BASE, 1);
  ctx.fillRect(x, y+17, BASE, 1);
  ctx.fillRect(x, y+24, BASE, 1);
  // Staggered vertical joints
  ctx.fillRect(x+8,  y+6,  1, 4);
  ctx.fillRect(x+20, y+6,  1, 4);
  ctx.fillRect(x+14, y+11, 1, 6);
  ctx.fillRect(x+26, y+11, 1, 6);
  ctx.fillRect(x+6,  y+18, 1, 6);
  ctx.fillRect(x+18, y+18, 1, 6);
  ctx.fillRect(x+12, y+25, 1, 7);
  ctx.fillRect(x+24, y+25, 1, 7);
  // Weathered highlights
  ctx.fillStyle = '#9aa4ad';
  ctx.fillRect(x+2,  y+12, 5, 3);
  ctx.fillRect(x+21, y+19, 5, 3);
}

// ── Tile & entity renderers ────────────────────────────────────────────────────

function drawTile(r, c, x, y, ts) {
  // Locked wilderness: dark forest, no grid stroke — a wall of unknown
  if (!inLand(r, c)) {
    ctx.fillStyle = '#22321f';
    ctx.fillRect(x, y, ts, ts);
    if (ts > 12) {
      const h = ((r * 2654435761) ^ (c * 40503)) >>> 0;
      ctx.fillStyle = '#1b2a19';
      const s = Math.max(2, Math.floor(ts / 5));
      ctx.fillRect(x + (h % 5) * ts / 8,        y + ((h >> 3) % 5) * ts / 8,        s, s);
      ctx.fillRect(x + ((h >> 6) % 5) * ts / 8, y + ((h >> 9) % 5) * ts / 8,        s, s);
      ctx.fillStyle = '#2a3d26';
      ctx.fillRect(x + ((h >> 12) % 6) * ts / 8, y + ((h >> 15) % 6) * ts / 8, Math.max(1, s - 1), Math.max(1, s - 1));
    }
    return;
  }
  if (ts <= 12) {
    const t = grid[r][c];
    ctx.fillStyle = t === GRASS ? grassPalette()[0] : (TILE_COLORS[t] || TILE_COLORS[0]);
    ctx.fillRect(x, y, ts, ts);
  } else {
    ctx.save();
    ctx.translate(x, y);
    if (ts !== BASE) ctx.scale(ts / BASE, ts / BASE);
    switch (grid[r][c]) {
      case GRASS:     drawGrass(0, 0);    break;
      case ROAD:      drawRoad(0, 0);     break;
      case HOUSE:     drawHouse(0, 0);    break;
      case SHOP:      drawShop(0, 0);     break;
      case PARK:      drawPark(0, 0);     break;
      case FACTORY:   drawFactory(0, 0);  break;
      case CHURCH:    drawChurch(0, 0);   break;
      case TOWN_HALL:  drawTownHall(0, 0);  break;
      case TREE_FARM:  drawTreeFarm(0, 0);  break;
      case STONE_FARM: drawStoneFarm(0, 0); break;
      case FARM:       drawFarm(0, 0);       break;
      case ROW_HOUSE:  drawRowHouse(0, 0);  break;
      case APARTMENT:  drawApartment(0, 0); break;
      case WELL:       drawWell(0, 0);      break;
      case SCHOOL:     drawSchool(0, 0);    break;
      case WALL:       drawWall(0, 0);      break;
    }
    ctx.restore();
    // Level pips on upgraded town halls
    if (grid[r][c] === TOWN_HALL) {
      const th = townHalls.find(t2 => t2.r === r && t2.c === c);
      const lvl = th ? (th.level || 1) : 1;
      if (lvl > 1) {
        ctx.fillStyle = '#ffd54f';
        const s = Math.max(2, Math.floor(ts / 10));
        for (let i = 0; i < lvl; i++) ctx.fillRect(x + 2 + i * (s + 2), y + 2, s, s);
      }
    }
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, ts - 1, ts - 1);
}

function drawResourceNodes() {
  const startC = Math.floor(camX), startR = Math.floor(camY);
  const endC   = Math.ceil(camX + canvas.width  / tileSize);
  const endR   = Math.ceil(camY + canvas.height / tileSize);

  for (let r = startR; r <= endR; r++) {
    for (let c = startC; c <= endC; c++) {
      if (!inBounds(r, c) || !inLand(r, c)) continue; // wilderness hides its riches
      const res = resourceMap[r][c];
      if (!res) continue;
      const { x, y } = tileToCanvas(r, c);
      const iconS = Math.max(3, Math.floor(tileSize * 0.25));
      const iconX = x + tileSize - iconS - 1;
      const iconY = y + tileSize - iconS - 1;
      ctx.fillStyle = RES_COLORS[res.type] || '#f9a825';
      ctx.fillRect(iconX, iconY, iconS, iconS);
    }
  }
}

function drawPeople() {
  for (const p of people) {
    if (p.insideBuilding) continue; // workers are hidden inside their building
    const { x: px, y: py } = tileToCanvas(p.y, p.x);
    if (px < -tileSize || px > canvas.width  + tileSize) continue;
    if (py < -tileSize || py > canvas.height + tileSize) continue;

    const carried = carriedTotal(p);

    // Selection ring around the inspected citizen
    if (p.id === selectedPersonId) {
      ctx.strokeStyle = '#ffee58';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
    }

    if (tileSize <= 12) {
      // Tiny dot: cyan = gather mode, player colour = build mode, yellow = carrying
      ctx.fillStyle = carried > 0 ? '#ffee58' : (p.mode === 'gather' ? '#4dd0e1' : p.color);
      ctx.fillRect(px + Math.floor(tileSize / 2) - 1, py + Math.floor(tileSize / 2) - 1, 2, 2);
    } else {
      const s = tileSize / BASE; // scale factor

      // Anchor sprite in lower-centre of tile
      const cx = px + Math.floor(tileSize / 2);
      const bot = py + Math.floor(tileSize * 0.88);

      // pixel helpers
      const px_ = (ox, oy, w, h) => ctx.fillRect(
        Math.round(cx + ox * s), Math.round(bot + oy * s),
        Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))
      );

      // Legs (two pixels wide each, animated by age parity)
      const legSwing = (p.age % 4 < 2) ? 1 : -1;
      ctx.fillStyle = '#5d4037';
      px_(-3,  -5 - legSwing,  2, 3);  // left leg
      px_( 1,  -5 + legSwing,  2, 3);  // right leg

      // Body / shirt in player colour
      ctx.fillStyle = p.color;
      px_(-4, -13, 8, 8);

      // Arms
      ctx.fillStyle = p.color;
      px_(-6, -12 + legSwing,  2, 4); // left arm
      px_( 4, -12 - legSwing,  2, 4); // right arm

      // Head — pale when hungry, green-tinged when sick, so trouble is visible
      ctx.fillStyle = p.sick ? '#c5e1a5' : p.hungry ? '#e8e0d8' : '#ffcc80';
      px_(-3, -19, 6, 6);

      const isSoldier = p.job === 'soldier';
      if (isSoldier) {
        // Iron helmet and a spear at the shoulder mark the militia
        ctx.fillStyle = '#78909c';
        px_(-4, -20, 8, 2);
        px_(-3, -21, 6, 1);
        ctx.fillStyle = '#8d6e63';
        px_(6, -22, 1, 12); // spear shaft
        ctx.fillStyle = '#cfd8dc';
        px_(5, -24, 3, 2);  // spearhead
      } else {
        // Level headband: bronze → silver → gold as citizens master their craft
        const lv = p.level || 0;
        if (lv >= 1) {
          ctx.fillStyle = lv >= 5 ? '#ffd54f' : lv >= 3 ? '#cfd8dc' : '#a1887f';
          px_(-4, -20, 8, 1);
        }
      }

      // Eyes
      ctx.fillStyle = '#333';
      px_(-2, -17, 1, 1);
      px_( 1, -17, 1, 1);

      // Mode indicator above head
      if (isSoldier && (p.mode === 'war' || p.mode === 'defend')) {
        // Red war pennant — this soldier is fighting
        ctx.fillStyle = '#e53935';
        px_(-1, -26, 1, 4); // staff
        px_(0, -26, 3, 2);  // pennant
      } else if (p.mode === 'gather') {
        // Cyan arrow pointing away from home (outward)
        ctx.fillStyle = '#4dd0e1';
        px_(-1, -23, 2, 3); // arrow shaft
        px_(-2, -24, 4, 1); // arrow head
      } else if (!isSoldier) {
        // Orange hammer icon (build mode)
        ctx.fillStyle = '#ff8f00';
        px_(-1, -23, 1, 3); // handle
        px_(-2, -25, 3, 2); // hammerhead
      }

      // Carried-resource pack (shown on back, above body)
      if (carried > 0) {
        const packColor = RES_COLORS[RES_KINDS.reduce((a, b) => ((p[a] || 0) >= (p[b] || 0) ? a : b))];
        // Pack strapped to back (top-right of body)
        ctx.fillStyle = packColor;
        px_(3, -14, 4, 5);
        // Small highlight on pack
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        px_(3, -14, 2, 2);
        // Fullness indicator: outline turns white when at carry cap
        if (carried >= carryCap(p)) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = Math.max(1, Math.round(s));
          ctx.strokeRect(
            Math.round(cx + 3 * s), Math.round(bot - 14 * s),
            Math.max(1, Math.round(4 * s)), Math.max(1, Math.round(5 * s))
          );
        }
      }
    }
  }
}

function nightOverlayAlpha() {
  const { hour, minute } = timeOfDay();
  const h    = hour + minute / 60;
  const fade = 1; // one in-game hour to fade in or out
  if (h >= HOUR_DAWN && h < HOUR_DAWN + fade)
    return 0.55 * (1 - (h - HOUR_DAWN) / fade);        // dawn: fade out
  if (h >= HOUR_DUSK - fade && h < HOUR_DUSK)
    return 0.55 * ((h - (HOUR_DUSK - fade)) / fade);   // pre-dusk: fade in
  if (h < HOUR_DAWN || h >= HOUR_DUSK) return 0.55;    // full night / evening
  return 0;
}

function drawDayNight() {
  const alpha = nightOverlayAlpha();
  if (alpha > 0) {
    ctx.fillStyle = `rgba(10,20,60,${alpha.toFixed(2)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  // Clock: top-right corner of canvas
  const { hour, minute } = timeOfDay();
  const h12  = hour % 12 || 12;
  const ampm = hour < 12 ? 'am' : 'pm';
  const mm   = String(minute).padStart(2, '0');
  const label = `${h12}:${mm}${ampm}`;
  ctx.font = 'bold 13px Monaco,monospace';
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillText(label, canvas.width - 7, 19);
  ctx.fillStyle = alpha > 0.15 ? '#c8d8ff' : '#ffffff';
  ctx.fillText(label, canvas.width - 8, 18);
  ctx.textAlign = 'left';
}

// render() only marks the frame dirty; the actual draw happens at most once
// per display frame in the rAF loop below. At 10× sim speed this stops the
// canvas from being redrawn synchronously inside every 25ms sim tick, and
// coalesces the flood of render() calls from mousemove/drag handlers.
let renderDirty = true;

function render() { renderDirty = true; }

function frameLoop() {
  if (renderDirty) {
    renderDirty = false;
    renderNow();
  }
  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);

function renderNow() {
  ctx.fillStyle = '#1a2633';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const startC = Math.floor(camX), startR = Math.floor(camY);
  const endC   = Math.ceil(camX + canvas.width  / tileSize);
  const endR   = Math.ceil(camY + canvas.height / tileSize);

  for (let r = startR; r <= endR; r++) {
    for (let c = startC; c <= endC; c++) {
      if (!inBounds(r, c)) continue;
      const { x, y } = tileToCanvas(r, c);
      drawTile(r, c, x, y, tileSize);
    }
  }

  if (inBounds(hoverR, hoverC)) {
    const { x, y } = tileToCanvas(hoverR, hoverC);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(x, y, tileSize, tileSize);
  }

  drawResourceNodes();
  drawFires();
  drawPeople();
  drawParticles();
  drawDayNight();
  drawLanterns();
}

function drawFires() {
  for (const key of Object.keys(burningTiles)) {
    const b = burningTiles[key];
    const { x, y } = tileToCanvas(b.r, b.c);
    if (x < -tileSize || x > canvas.width || y < -tileSize || y > canvas.height) continue;
    // Flickering flame overlay
    const flick = (simTick + b.r + b.c) % 3;
    ctx.fillStyle = flick === 0 ? 'rgba(255,111,0,0.55)' : flick === 1 ? 'rgba(255,152,0,0.55)' : 'rgba(255,193,7,0.5)';
    ctx.fillRect(x, y, tileSize, tileSize);
    // Flame tongues
    ctx.fillStyle = flick === 0 ? '#ffee58' : '#ff9800';
    const s = Math.max(2, Math.floor(tileSize / 5));
    ctx.fillRect(x + tileSize * 0.2, y + tileSize * 0.15 + flick, s, s * 2);
    ctx.fillRect(x + tileSize * 0.6, y + tileSize * 0.35 - flick, s, s * 2);
  }
}

function drawParticles() {
  for (const pt of particles) {
    const { x, y } = tileToCanvas(pt.y, pt.x);
    if (x < -tileSize || x > canvas.width || y < -tileSize || y > canvas.height) continue;
    ctx.globalAlpha = Math.max(0, pt.life / pt.maxLife);
    ctx.fillStyle = pt.color;
    const s = Math.max(2, Math.floor(tileSize / 10));
    ctx.fillRect(Math.round(x), Math.round(y), s, s);
  }
  ctx.globalAlpha = 1;
}

// Warm lantern glows on people out after dark — drawn above the night overlay
function drawLanterns() {
  if (nightOverlayAlpha() < 0.3) return;
  for (const p of people) {
    if (p.insideBuilding) continue;
    const { x: px, y: py } = tileToCanvas(p.y, p.x);
    if (px < -tileSize || px > canvas.width || py < -tileSize || py > canvas.height) continue;
    const cx = px + tileSize / 2, cy = py + tileSize / 2;
    const rad = Math.max(3, tileSize * 0.45);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grad.addColorStop(0, 'rgba(255,200,90,0.35)');
    grad.addColorStop(1, 'rgba(255,200,90,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    ctx.fillStyle = '#ffd54f';
    const s = Math.max(1, Math.floor(tileSize / 12));
    ctx.fillRect(Math.round(cx), Math.round(cy - s), s, s);
  }
}
