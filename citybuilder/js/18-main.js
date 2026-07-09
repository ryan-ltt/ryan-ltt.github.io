// ═══ citybuilder/js/18-main.js ════════════════════════════════════════
// Init entry point: sizes the canvas, seeds resources, auto-loads the save, centers the camera. Must load last.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

// ── Init ──────────────────────────────────────────────────────────────────────

resizeCanvasToDisplay(); // sync, so the camera math below sees the real size
clampCamera();
initResourceMap();

// Auto-load save if one exists
if (!loadGame()) {
  render();
  updateUI();
}

// Open the camera on the known world (or the first town if one exists)
{
  const focus = townHalls[0] || { r: LAND_CENTER, c: LAND_CENTER };
  camX = focus.c + 0.5 - (canvas.width  / tileSize) / 2;
  camY = focus.r + 0.5 - (canvas.height / tileSize) / 2;
  clampCamera();
  render();
}
