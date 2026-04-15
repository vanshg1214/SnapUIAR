// tap-place.js — Industry-grade AR gesture control
//
// Drag   : raycast camera→finger→ground plane (model follows finger exactly)
// Rotate : two-finger angle delta (atan2)
// Scale  : two-finger spread ratio (multiplicative, no drift)
//
// Everything uses native Touch events — zero xrextras gesture dependency.

export const tapPlaceComponent = {
  schema: {
    min: {default: 5.0625},
    max: {default: 5.0625},
  },

  init() {
    const ground  = document.getElementById('ground')
    this.prompt   = document.getElementById('promptText')

    // ── Core state ─────────────────────────────────────────
    this.hasPlacedModel   = false
    this.placedEntity     = null
    this.modelChild       = null
    this.activeModel      = '#pizzaModel'
    this.gesturesEnabled  = false   // only true after entrance anim finishes

    // Per-model scale normalisation (tweak these to resize individual models)
    this.modelScales = {
      '#pizzaModel'         : 1.0,
      '#pizza2Model'        : 1.0,
      '#krabbyPattyModel'   : 1.0,
      '#classicBurgerModel' : 1.0,
    }

    // Per-model Y-offset fine-tuning (relative to normalized bottom)
    this.modelYOffsets = {
      '#classicBurgerModel': -0.25,
      '#krabbyPattyModel': -0.1,    // Added Krabby Patty adjustment if needed
    }

    this._initFilterUI()
    this._initGestures()

    // ── Ground tap → place model ────────────────────────────
    ground.addEventListener('click', (event) => {
      if (this.hasPlacedModel) return
      this._placeModel(event)
    })
  },

  // ══════════════════════════════════════════════════════════
  //  FILTER TRAY
  // ══════════════════════════════════════════════════════════
  _initFilterUI() {
    const buttons         = document.querySelectorAll('.filter-button')
    const filterContainer = document.getElementById('filterContainer')
    this._filterContainer = filterContainer

    const activateModel = (button) => {
      if (button.classList.contains('active')) return
      buttons.forEach(b => b.classList.remove('active'))
      button.classList.add('active')
      this.activeModel = button.getAttribute('data-model')

      // Live-swap model if one is already placed
      if (this.placedEntity && this.modelChild) {
        this.placedEntity.removeChild(this.modelChild)
        const child = document.createElement('a-entity')
        child.setAttribute('gltf-model', this.activeModel)
        child.setAttribute('shadow', {receive: false})
        this._normalizeModel(child)
        this.placedEntity.appendChild(child)
        this.modelChild = child
      }
    }

    // Scroll → detect the geometrically centred button
    const detectCenter = () => {
      const mid = filterContainer.scrollLeft + filterContainer.clientWidth / 2
      let closest = null, minDist = Infinity
      buttons.forEach(b => {
        const d = Math.abs(b.offsetLeft + b.offsetWidth / 2 - mid)
        if (d < minDist) { minDist = d; closest = b }
      })
      if (closest) activateModel(closest)
    }

    filterContainer.addEventListener('scroll', detectCenter)
    requestAnimationFrame(detectCenter)   // initialise on first paint

    buttons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        btn.scrollIntoView({behavior: 'smooth', inline: 'center', block: 'nearest'})
      })
    })
  },

  // ══════════════════════════════════════════════════════════
  //  PLACE MODEL
  // ══════════════════════════════════════════════════════════
  _placeModel(event) {
    this.prompt.style.display = 'none'

    const touchPoint = event.detail.intersection.point
    const newElement = document.createElement('a-entity')

    newElement.setAttribute('position', touchPoint)
    newElement.setAttribute('rotation', `0 ${Math.random() * 360} 0`)
    newElement.setAttribute('visible',  'false')
    newElement.setAttribute('scale',    '0.0001 0.0001 0.0001')
    newElement.classList.add('cantap')

    const finalScale  = Math.random() * (this.data.max - this.data.min) + this.data.min

    // Child holds the GLTF model (separate from gesture parent)
    const modelChild = document.createElement('a-entity')
    modelChild.setAttribute('gltf-model', this.activeModel)
    modelChild.setAttribute('shadow', {receive: false})

    // Normalise and handle entrance
    modelChild.addEventListener('model-loaded', () => {
      this._normalizeModel(modelChild)
      
      if (!this.hasAnimated) {
        this.hasAnimated = true
        newElement.setAttribute('visible', 'true')
        newElement.setAttribute('animation', {
          property: 'scale',
          to:       `${finalScale} ${finalScale} ${finalScale}`,
          easing:   'easeOutElastic',
          dur:      800,
        })
      }
    })

    this.modelChild = modelChild
    newElement.appendChild(modelChild)
    this.el.sceneEl.appendChild(newElement)

    this.hasPlacedModel  = true
    this.placedEntity    = newElement
    this.hasAnimated     = false
    this.gesturesEnabled = false

    // Enable gestures once animation is done (or after 1.2 s fallback)
    const enable = () => {
      if (this.gesturesEnabled) return
      this.gesturesEnabled = true
    }
    newElement.addEventListener('animationcomplete', enable)
    setTimeout(enable, 1200)
  },

  // ══════════════════════════════════════════════════════════
  //  GESTURE SYSTEM  (native Touch events, no xrextras)
  // ══════════════════════════════════════════════════════════
  _initGestures() {
    // Reusable Three.js objects – allocated once, never inside the hot path
    this._raycaster = new THREE.Raycaster()
    this._hitPoint  = new THREE.Vector3()
    this._hitPlane  = new THREE.Plane()   // rebuilt per drag to use model's Y

    // Live touch registry: identifier → {x, y}
    this._touches = new Map()

    // Two-finger session state
    this._prevAngle  = null
    this._prevSpread = null

    // ── Helpers ─────────────────────────────────────────────

    // Returns true if the touch point lands on a UI element we should NOT intercept
    const isUITouch = (t) => {
      const el = document.elementFromPoint(t.clientX, t.clientY)
      return el && !!el.closest('#filterContainer, .capture-ring')
    }

    // ── touchstart ───────────────────────────────────────────
    const onStart = (e) => {
      Array.from(e.changedTouches).forEach(t => {
        if (!isUITouch(t)) {
          this._touches.set(t.identifier, {x: t.clientX, y: t.clientY})
        }
      })
      // Reset two-finger state on any touch count change
      this._prevAngle  = null
      this._prevSpread = null
    }

    // ── touchmove ────────────────────────────────────────────
    const onMove = (e) => {
      if (!this.gesturesEnabled || !this.placedEntity) return

      let handled = false
      Array.from(e.changedTouches).forEach(t => {
        if (this._touches.has(t.identifier)) {
          this._touches.set(t.identifier, {x: t.clientX, y: t.clientY})
          handled = true
        }
      })
      if (!handled) return

      const pts = Array.from(this._touches.values())

      if (pts.length === 1) {
        // Single finger → drag
        this._drag(pts[0])
        e.preventDefault()           // stop page scroll while dragging
      } else if (pts.length >= 2) {
        // Two fingers → pinch-scale + rotate simultaneously
        this._pinchRotate(pts[0], pts[1])
        e.preventDefault()
      }
    }

    // ── touchend / touchcancel ───────────────────────────────
    const onEnd = (e) => {
      Array.from(e.changedTouches).forEach(t => {
        this._touches.delete(t.identifier)
      })
      this._prevAngle  = null
      this._prevSpread = null
    }

    // Attach to document — catches touches anywhere on screen
    document.addEventListener('touchstart',  onStart, {passive: true})
    document.addEventListener('touchmove',   onMove,  {passive: false})  // passive:false to allow preventDefault
    document.addEventListener('touchend',    onEnd,   {passive: true})
    document.addEventListener('touchcancel', onEnd,   {passive: true})
  },

  // ── DRAG ────────────────────────────────────────────────────
  // Raycast from camera through the touch point onto a horizontal plane
  // sitting at the model's current world-Y. This makes the model track
  // the finger's exact ground position regardless of camera angle.
  _drag(touch) {
    const entity = this.placedEntity
    if (!entity) return

    const camera = this.el.sceneEl.camera
    const canvas = this.el.sceneEl.canvas
    const rect   = canvas.getBoundingClientRect()

    // Convert screen px → Normalised Device Coordinates [-1, +1]
    const ndcX =  ((touch.x - rect.left) / rect.width)  * 2 - 1
    const ndcY = -((touch.y - rect.top)  / rect.height) * 2 + 1

    this._raycaster.setFromCamera({x: ndcX, y: ndcY}, camera)

    // Build a plane at the model's current height (stays on the surface)
    const modelY = entity.object3D.position.y
    this._hitPlane.set(new THREE.Vector3(0, 1, 0), -modelY)

    if (this._raycaster.ray.intersectPlane(this._hitPlane, this._hitPoint)) {
      // Only move on XZ — keep Y (height) locked
      entity.object3D.position.x = this._hitPoint.x
      entity.object3D.position.z = this._hitPoint.z
    }
  },

  // ── PINCH + ROTATE ─────────────────────────────────────────
  // Both gestures are computed simultaneously from the same two touches.
  // Using RATIO for scale (not delta) prevents cumulative drift.
  // Using angle DELTA (radians) for rotation is frame-rate independent.
  _pinchRotate(t1, t2) {
    const entity = this.placedEntity
    if (!entity) return

    const angle  = Math.atan2(t2.y - t1.y, t2.x - t1.x)   // current finger angle
    const spread = Math.hypot(t2.x - t1.x, t2.y - t1.y)   // current finger distance

    if (this._prevAngle !== null) {
      // ── Rotation ──
      const dAngle = angle - this._prevAngle
      entity.object3D.rotation.y -= dAngle    // subtract so clockwise drag = clockwise model

      // Scale is intentionally disabled to lock models to exactly 30cm
    }

    this._prevAngle  = angle
    this._prevSpread = spread
  },

  // ── INTERNAL HELPERS ────────────────────────────────────────

  // Bounding-box normalisation:
  // 1. Scales model so its max dimension is exactly 1.0 unit
  // 2. Multiplies by user-defined modelScales (fine-tuning)
  // 3. Offsets Y so the MINIMUM of the bounding box is at 0 (sits on floor)
  _normalizeModel(entity) {
    const obj = entity.getObject3D('mesh')
    if (!obj) {
      // Ensure it's hidden while loading to prevent "pop-in" at native scale
      entity.object3D.visible = false
      entity.addEventListener('model-loaded', () => this._normalizeModel(entity), {once: true})
      return
    }

    // Temporarily reset all parent scales and rotations to measure unscaled native size
    const backups = [];
    let curr = entity.object3D;
    let root = curr;
    while (curr) {
      backups.push({
        obj: curr,
        scale: curr.scale.clone(),
        rotation: curr.rotation.clone()
      });
      curr.scale.set(1, 1, 1);
      curr.rotation.set(0, 0, 0);
      root = curr;
      curr = curr.parent;
    }

    // 1. Calculate true native base size of visual meshes ONLY
    // MUST update from the root down to ensure parent matrix resets propagate!
    root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    obj.traverse((child) => {
      if (child.isMesh) {
        box.expandByObject(child);
      }
    });

    // If no meshes found, fallback to full object
    if (box.isEmpty()) box.setFromObject(obj);

    const size = new THREE.Vector3();
    box.getSize(size);

    // Calculate unscaled bottom Y relative to the object's origin
    const target = new THREE.Vector3();
    obj.getWorldPosition(target);
    const localBottomY = box.min.y - target.y;

    // Restore original scales and rotations
    for (const item of backups) {
      item.obj.scale.copy(item.scale);
      item.obj.rotation.copy(item.rotation);
    }

    // 2. Apply scale
    const maxDim = Math.max(size.x, size.y, size.z)
    let s = 1.0;
    if (maxDim > 0) {
      const userScale = this.modelScales[this.activeModel] || 1.0
      s = (1.0 / maxDim) * userScale
      entity.object3D.scale.set(s, s, s)
    }

    // 3. Settle on floor
    // Ensure world matrices are fully updated after scale change
    entity.object3D.updateMatrixWorld(true);
    const yOffset = this.modelYOffsets[this.activeModel] || 0;
    entity.object3D.position.y = (-localBottomY * s) + yOffset;

    // 4. Finally show the correctly sized model
    entity.object3D.visible = true
  },
}
