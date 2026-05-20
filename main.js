(() => {
  // Where the WHITE PAPER INTERIOR sits inside the roll image (fractions of image w/h).
  // Measured from cropped roll.png (1536×2314): white interior x=635..1267, paper
  // extends to the very bottom of the image (y=2313, ≈100% of image height).
  const TORN_LEFT_PCT = 0.4134;
  const TORN_RIGHT_PCT = 0.8249;
  const TORN_TOP_PCT = 1.0;
  // How many CSS pixels the visible plane top is ABOVE the bottom of the image.
  // Small positive value = the plane overlaps the last few px of the image's paper
  // so the transition is hidden inside solid white (no visible seam).
  const PLANE_TOP_INSIDE_PX = 25;
  // Visible plane height as a fraction of the roll image height.
  const PLANE_HEIGHT_RATIO = 0.3;
  // How many bottom rows participate in the torn edge (random Y wobble).
  const TORN_BOTTOM_ROWS = 5;
  const TORN_BOTTOM_AMP = 0.45; // world units of Y jitter at the bottom row
  const IMAGE_BORDER_NATIVE_PX = 15;
  const BORDER_COLOR = "#1a0e07";

  const settings = {
    planeUnitH: 16,
    segmentsY: 48, // halved — physics + vertex loop run twice as fast
    fadeDist: 3.2,
  };

  const interaction = {
    dentRadius: 1.4,
    dentDepth: 0.5,
    rampUp: 0.18,
    rampDown: 0.06,
    velSmooth: 0.55,
    velMax: 0.55,
    // Rope physics — each horizontal slice of the plane is a node with an
    // ABSOLUTE position in plane-local coords. Adjacent nodes maintain a fixed
    // distance (restDist) via iterative constraint projection. Gravity tugs each
    // node down. The top node is anchored, the bottom dangles like a pendulum.
    chainDamp: 0.95, // velocity retention per frame (higher → longer swing)
    chainGravity: 0.018, // downward force per frame (world units)
    chainIterations: 3, // constraint passes per frame for rope stability
    chainSmoothing: 0.4, // 0..1: Laplacian bend resistance — kills sharp kinks
    chainSmoothingPasses: 2, // how many times to apply smoothing per frame
  };

  const img = document.querySelector(".roll");
  const canvas = document.getElementById("scene");

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
  keyLight.position.set(2, 3, 5);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.25);
  rimLight.position.set(-3, 1, 2);
  scene.add(rimLight);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);

  // MeshBasic — no lighting/normals math each frame. Paper is flat-shaded white,
  // fully opaque (no fade) so the plane reads as continuous with the image's
  // white paper above it.
  const paperMaterial = new THREE.MeshBasicMaterial({
    color: "#fefeff",
    side: THREE.DoubleSide,
  });
  const borderMaterial = new THREE.MeshBasicMaterial({
    color: BORDER_COLOR,
    side: THREE.DoubleSide,
  });

  let sheet = null;
  let positions = null;
  let baseX = null;
  let baseY = null;
  let count = 0;
  let planeW = 4;
  let planeH = settings.planeUnitH;
  let pxPerUnit = 1;
  let segX = 0;
  let borderWidthPx = 2; // CSS pixels; recomputed from the image scale in alignCanvas.
  let borderL = null;
  let borderR = null;
  let borderLPos = null;
  let borderRPos = null;
  // Per-row rope physics — absolute positions in plane-local coords.
  let rowX = null;
  let rowY = null;
  let rowXPrev = null;
  let rowYPrev = null;
  let restDist = 0; // distance between consecutive row nodes (rope link length)

  function makeBorderGeometry(segY) {
    const geo = new THREE.BufferGeometry();
    const numVerts = (segY + 1) * 2;
    const pos = new Float32Array(numVerts * 3);
    const idx = [];
    for (let row = 0; row < segY; row++) {
      const tl = row * 2;
      const tr = row * 2 + 1;
      const bl = (row + 1) * 2;
      const br = (row + 1) * 2 + 1;
      idx.push(tl, bl, tr, tr, bl, br);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return geo;
  }

  function buildSheet() {
    if (sheet) {
      scene.remove(sheet);
      sheet.geometry.dispose();
    }
    if (borderL) {
      scene.remove(borderL);
      borderL.geometry.dispose();
    }
    if (borderR) {
      scene.remove(borderR);
      borderR.geometry.dispose();
    }

    const aspect = planeW / planeH;
    segX = Math.max(8, Math.round(settings.segmentsY * aspect));
    const segY = settings.segmentsY;
    const geo = new THREE.PlaneGeometry(planeW, planeH, segX, segY);
    sheet = new THREE.Mesh(geo, paperMaterial);
    scene.add(sheet);
    positions = sheet.geometry.attributes.position;
    count = positions.count;
    baseX = new Float32Array(count);
    baseY = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      baseX[i] = positions.getX(i);
      baseY[i] = positions.getY(i);
    }

    // Torn bottom edge — stable pseudo-random Y wobble on the last few rows,
    // fading to 0 at the side corners so the brown borders still end cleanly.
    const colsPlus1 = segX + 1;
    for (let r = segY - TORN_BOTTOM_ROWS + 1; r <= segY; r++) {
      const tRow = (r - (segY - TORN_BOTTOM_ROWS + 1)) / (TORN_BOTTOM_ROWS - 1); // 0 top..1 bottom
      const strength = tRow * TORN_BOTTOM_AMP;
      for (let c = 0; c <= segX; c++) {
        const idx = r * colsPlus1 + c;
        const cornerFade = 1 - Math.pow(Math.abs(c / segX - 0.5) * 2, 2); // 0 at corners, 1 in the middle
        const h = Math.sin(c * 12.9898 + r * 4.137) * 43758.5453;
        const rand = h - Math.floor(h);
        const jag = (rand - 0.5) * 2 * strength * cornerFade;
        baseY[idx] += jag;
        positions.setY(idx, baseY[idx]);
      }
    }

    borderL = new THREE.Mesh(makeBorderGeometry(segY), borderMaterial);
    borderR = new THREE.Mesh(makeBorderGeometry(segY), borderMaterial);
    // Parent to sheet so they inherit the plane's vertical offset within the canvas.
    sheet.add(borderL);
    sheet.add(borderR);
    borderLPos = borderL.geometry.attributes.position;
    borderRPos = borderR.geometry.attributes.position;

    const numRows = segY + 1;
    rowX = new Float32Array(numRows);
    rowY = new Float32Array(numRows);
    rowXPrev = new Float32Array(numRows);
    rowYPrev = new Float32Array(numRows);
    restDist = planeH / segY;
    // Initialize at rest — straight rope hanging from top.
    for (let r = 0; r <= segY; r++) {
      rowX[r] = 0;
      rowY[r] = planeH / 2 - r * restDist;
      rowXPrev[r] = rowX[r];
      rowYPrev[r] = rowY[r];
    }
  }

  const noise = new Noise(Math.random());

  // === Audio: one of three "tear" sounds plays on each grab release. ===
  // Preload as plain Audio elements; clone-and-play allows overlapping playbacks
  // when the user releases rapidly.
  const SOUND_FILES = ["assets/f1.mp3", "assets/f2.mp3", "assets/f3.mp3"];
  const sounds = SOUND_FILES.map((src) => {
    const a = new Audio(src);
    a.preload = "auto";
    a.volume = 0.9;
    return a;
  });
  function playReleaseSound() {
    const pick = sounds[Math.floor(Math.random() * sounds.length)];
    const node = pick.cloneNode();
    node.volume = pick.volume;
    // Browsers may reject autoplay without prior user gesture; we always trigger
    // this from pointerup, which counts as a gesture — but we still swallow errors.
    node.play().catch(() => {});
  }

  // === Disable browser zoom on both mobile and desktop. ===
  // 1. Pinch-to-zoom on touch: catch multi-touch gestures and cancel them.
  window.addEventListener(
    "gesturestart",
    (e) => e.preventDefault(),
    { passive: false }
  );
  window.addEventListener(
    "gesturechange",
    (e) => e.preventDefault(),
    { passive: false }
  );
  window.addEventListener(
    "gestureend",
    (e) => e.preventDefault(),
    { passive: false }
  );
  // 2. Ctrl+wheel zoom (desktop).
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false }
  );
  // 3. Ctrl/Cmd + (+ / - / 0) keyboard zoom (desktop).
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "_", "0"].includes(e.key)) {
      e.preventDefault();
    }
  });

  function alignCanvas() {
    if (!img.complete || !img.naturalWidth) return;
    const r = img.getBoundingClientRect();
    const paperLeft = r.left + r.width * TORN_LEFT_PCT;
    const paperRight = r.left + r.width * TORN_RIGHT_PCT;
    const paperWidthPx = paperRight - paperLeft;
    const paperCenterCssX = (paperLeft + paperRight) / 2;

    // Where the visible plane top should land in CSS coords.
    const planeTopCssY = r.top + r.height * TORN_TOP_PCT - PLANE_TOP_INSIDE_PX;
    const planeHCss = Math.max(160, r.height * PLANE_HEIGHT_RATIO);

    // Canvas DOM covers the entire viewport — no frame, no clipping anywhere.
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    canvas.style.left = "0px";
    canvas.style.top = "0px";
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    renderer.setSize(cssW, cssH, false);

    planeH = settings.planeUnitH;
    pxPerUnit = planeHCss / planeH;
    planeW = paperWidthPx / pxPerUnit;
    const cameraW = cssW / pxPerUnit;
    const cameraH = cssH / pxPerUnit;

    const imgScale = r.width / (img.naturalWidth || 1536);
    borderWidthPx = Math.max(1.5, IMAGE_BORDER_NATIVE_PX * imgScale);

    camera.left = -cameraW / 2;
    camera.right = cameraW / 2;
    camera.top = cameraH / 2;
    camera.bottom = -cameraH / 2;
    camera.updateProjectionMatrix();

    buildSheet();

    // Position plane so its top edge sits at planeTopCssY in CSS and its horizontal
    // centre sits at paperCenterCssX. CSS y=0 corresponds to world y=+cameraH/2;
    // CSS x=0 corresponds to world x=-cameraW/2.
    const planeTopWorldY = cameraH / 2 - planeTopCssY / pxPerUnit;
    const planeCenterWorldX = paperCenterCssX / pxPerUnit - cameraW / 2;
    sheet.position.x = planeCenterWorldX;
    sheet.position.y = planeTopWorldY - planeH / 2;
  }

  if (img.complete && img.naturalWidth > 0) {
    alignCanvas();
  } else {
    img.addEventListener("load", alignCanvas);
  }
  window.addEventListener("resize", alignCanvas);

  const pointer = {
    inside: false,
    strength: 0,
    localX: 0,
    localY: 0,
  };

  const grab = {
    active: false,
    recovering: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    lastX: 0,
    lastY: 0,
    vx: 0,
    vy: 0,
    lift: 0,
    pointerId: null,
  };

  const ndc = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const sheetPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const hitPoint = new THREE.Vector3();

  function updatePointer(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    if (raycaster.ray.intersectPlane(sheetPlane, hitPoint)) {
      // Convert world coords to mesh-local (sheet is offset within full-screen canvas).
      pointer.localX = hitPoint.x - (sheet ? sheet.position.x : 0);
      pointer.localY = hitPoint.y - (sheet ? sheet.position.y : 0);
      // Generous margin so clicks on the torn-edge fringe and on the rope when
      // it's swung off-rest still register as a valid grab.
      const xMargin = 0.4;
      const yMargin = 1.8;
      pointer.inside =
        Math.abs(pointer.localX) <= planeW / 2 + xMargin &&
        pointer.localY <= planeH / 2 + yMargin &&
        pointer.localY >= -planeH / 2 - yMargin;
      return true;
    }
    pointer.inside = false;
    return false;
  }

  function releaseGrab() {
    if (!grab.active) return;
    grab.active = false;
    grab.recovering = true; // velocity carries forward into spring-back
    if (grab.pointerId !== null && canvas.hasPointerCapture(grab.pointerId)) {
      canvas.releasePointerCapture(grab.pointerId);
    }
    grab.pointerId = null;
    playReleaseSound();
  }

  canvas.addEventListener("pointermove", (e) => {
    updatePointer(e.clientX, e.clientY);
    if (grab.active) {
      grab.currentX = pointer.localX;
      grab.currentY = pointer.localY;
    }
  });
  canvas.addEventListener("pointerdown", (e) => {
    if (updatePointer(e.clientX, e.clientY) && pointer.inside) {
      grab.active = true;
      grab.recovering = false;
      grab.startX = pointer.localX;
      grab.startY = pointer.localY;
      grab.currentX = pointer.localX;
      grab.currentY = pointer.localY;
      grab.lastX = pointer.localX;
      grab.lastY = pointer.localY;
      grab.vx = 0;
      grab.vy = 0;
      grab.pointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener("pointerup", releaseGrab);
  canvas.addEventListener("pointercancel", releaseGrab);
  canvas.addEventListener("pointerleave", () => {
    pointer.inside = false;
    releaseGrab();
  });
  canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

  function anchorFactor(by) {
    const distFromTop = planeH / 2 - by;
    return Math.min(1, Math.max(0, distFromTop / settings.fadeDist));
  }

  function update() {
    if (!sheet) return;

    // Track per-frame velocity of the cursor in plane-local coords (used to give
    // the grabbed row inherited momentum when the user lets go).
    if (grab.active) {
      const dvx = grab.currentX - grab.lastX;
      const dvy = grab.currentY - grab.lastY;
      const s = interaction.velSmooth;
      grab.vx = grab.vx * s + dvx * (1 - s);
      grab.vy = grab.vy * s + dvy * (1 - s);
      const speed = Math.hypot(grab.vx, grab.vy);
      if (speed > interaction.velMax) {
        grab.vx *= interaction.velMax / speed;
        grab.vy *= interaction.velMax / speed;
      }
      grab.lastX = grab.currentX;
      grab.lastY = grab.currentY;
    }

    // Map grab.startY (local Y) → row index in the rope.
    let grabbedRow = -1;
    if (grab.active) {
      grabbedRow = Math.round(((planeH / 2 - grab.startY) / planeH) * settings.segmentsY);
      grabbedRow = Math.max(1, Math.min(settings.segmentsY, grabbedRow));
    }

    // === Rope physics: Verlet + distance constraint ===
    const segY = settings.segmentsY;
    // Anchor top node at the torn-edge position.
    const topRestY = planeH / 2;
    rowX[0] = 0;
    rowY[0] = topRestY;
    rowXPrev[0] = 0;
    rowYPrev[0] = topRestY;

    for (let r = 1; r <= segY; r++) {
      if (r === grabbedRow) {
        // Grab row pinned to cursor; previous position pre-biased so the row
        // inherits cursor velocity if the user releases mid-flick.
        rowX[r] = grab.currentX;
        rowY[r] = grab.currentY;
        rowXPrev[r] = grab.currentX - grab.vx;
        rowYPrev[r] = grab.currentY - grab.vy;
        continue;
      }
      // Verlet velocity (with damping)
      const vx = (rowX[r] - rowXPrev[r]) * interaction.chainDamp;
      const vy = (rowY[r] - rowYPrev[r]) * interaction.chainDamp;
      rowXPrev[r] = rowX[r];
      rowYPrev[r] = rowY[r];
      rowX[r] += vx;
      rowY[r] += vy - interaction.chainGravity; // gravity pulls -Y
    }

    // Distance constraint — each link between adjacent rows is restDist long.
    // Multiple iterations + bidirectional passes give a stable rope.
    for (let iter = 0; iter < interaction.chainIterations; iter++) {
      for (let r = 1; r <= segY; r++) {
        const aboveFixed = r - 1 === 0 || r - 1 === grabbedRow;
        const thisFixed = r === grabbedRow;
        if (thisFixed) continue;
        const dx = rowX[r] - rowX[r - 1];
        const dy = rowY[r] - rowY[r - 1];
        const len = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        const diff = (len - restDist) / len;
        if (aboveFixed) {
          rowX[r] -= dx * diff;
          rowY[r] -= dy * diff;
        } else {
          rowX[r - 1] += dx * diff * 0.5;
          rowY[r - 1] += dy * diff * 0.5;
          rowX[r] -= dx * diff * 0.5;
          rowY[r] -= dy * diff * 0.5;
        }
      }
    }

    // Bending resistance — pull each non-grabbed row toward the midpoint of its
    // neighbours. Multiple passes round out sharp angles into smooth curves.
    const smooth = interaction.chainSmoothing;
    if (smooth > 0) {
      for (let pass = 0; pass < interaction.chainSmoothingPasses; pass++) {
        for (let r = 1; r < segY; r++) {
          if (r === grabbedRow) continue;
          if (r - 1 === grabbedRow || r + 1 === grabbedRow) continue; // keep grab response crisp
          const midX = (rowX[r - 1] + rowX[r + 1]) * 0.5;
          const midY = (rowY[r - 1] + rowY[r + 1]) * 0.5;
          rowX[r] += (midX - rowX[r]) * smooth;
          rowY[r] += (midY - rowY[r]) * smooth;
        }
      }
      // Re-project distance constraint once after smoothing to recover any drift.
      for (let r = 1; r <= segY; r++) {
        if (r === grabbedRow) continue;
        const aboveFixed = r - 1 === 0 || r - 1 === grabbedRow;
        const dx = rowX[r] - rowX[r - 1];
        const dy = rowY[r] - rowY[r - 1];
        const len = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        const diff = (len - restDist) / len;
        if (aboveFixed) {
          rowX[r] -= dx * diff;
          rowY[r] -= dy * diff;
        } else {
          rowX[r - 1] += dx * diff * 0.5;
          rowY[r - 1] += dy * diff * 0.5;
          rowX[r] -= dx * diff * 0.5;
          rowY[r] -= dy * diff * 0.5;
        }
      }
    }

    const colsPlus1 = segX + 1;

    for (let i = 0; i < count; i++) {
      const bx = baseX[i];
      const by = baseY[i];
      const anchor = anchorFactor(by);

      // Row offset = (current rope position of row) - (rest position of row).
      const rowIdx = (i / colsPlus1) | 0;
      const restRowY = planeH / 2 - rowIdx * restDist;
      const rowOffX = rowX[rowIdx] * anchor;
      const rowOffY = (rowY[rowIdx] - restRowY) * anchor;

      positions.setXYZ(i, bx + rowOffX, by + rowOffY, 0);
    }
    positions.needsUpdate = true;
    // No computeVertexNormals — using MeshBasicMaterial, normals aren't sampled.

    // Side borders mirror the deformed edge columns.
    const borderWidthWorld = borderWidthPx / pxPerUnit;
    for (let row = 0; row <= segY; row++) {
      const leftIdx = row * colsPlus1;
      const rightIdx = row * colsPlus1 + segX;

      const lx = positions.getX(leftIdx);
      const ly = positions.getY(leftIdx);
      const lz = positions.getZ(leftIdx);

      const rx = positions.getX(rightIdx);
      const ry = positions.getY(rightIdx);
      const rz = positions.getZ(rightIdx);

      const baseRow = row * 2;
      // Left border extends outward (to the left) from the plane's left edge.
      borderLPos.setXYZ(baseRow, lx, ly, lz);
      borderLPos.setXYZ(baseRow + 1, lx - borderWidthWorld, ly, lz);
      // Right border extends outward (to the right) from the plane's right edge.
      borderRPos.setXYZ(baseRow, rx, ry, rz);
      borderRPos.setXYZ(baseRow + 1, rx + borderWidthWorld, ry, rz);
    }
    borderLPos.needsUpdate = true;
    borderRPos.needsUpdate = true;
  }

  function render() {
    update();
    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }

  render();
})();
