import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { inspectGlb, type GlbReport } from "@reelterminal/core/review/glb";
import type { ModelObservation } from "@reelterminal/core/types/workbench";

export type StandardView = "front" | "back" | "left" | "right" | "top";
export interface PreviewInfo extends GlbReport { animations: { name: string; duration: number }[]; bounds: number[]; renderer: string }

/** Every runtime owns its loader results; no shared model/texture cache. */
function releaseObjects(objects: readonly THREE.Object3D[], extraTextures: readonly THREE.Texture[] = [], released = new Set<object>()): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>(), bitmaps = new Set<ImageBitmap>();
  for (const texture of extraTextures) textures.add(texture);
  const skeletons = new Set<THREE.Skeleton>();
  for (const scene of objects) scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    if ((object as THREE.SkinnedMesh).skeleton) skeletons.add((object as THREE.SkinnedMesh).skeleton);
  });
  for (const material of materials) for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
  for (const texture of textures) {
    if (typeof ImageBitmap !== "undefined" && texture.source.data instanceof ImageBitmap) bitmaps.add(texture.source.data);
    if (!released.has(texture)) { texture.dispose(); released.add(texture); }
  }
  for (const bitmap of bitmaps) if (!released.has(bitmap)) { bitmap.close(); released.add(bitmap); }
  for (const skeleton of skeletons) if (!released.has(skeleton)) { skeleton.dispose(); released.add(skeleton); }
  for (const material of materials) if (!released.has(material)) { material.dispose(); released.add(material); }
  for (const geometry of geometries) if (!released.has(geometry)) { geometry.dispose(); released.add(geometry); }
}

export class ModelPreviewRuntime {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  readonly controls: OrbitControls;
  private readonly scene = new THREE.Scene();
  private readonly environment: THREE.WebGLRenderTarget;
  private gltf?: GLTF;
  private mixer?: THREE.AnimationMixer;
  private action?: THREE.AnimationAction;
  private animationIndex = -1;
  private playing = false;
  private background: "light" | "dark" = "dark";
  private disposed = false;
  private visible = true;
  private frame = 0;
  private initializing = false;
  private previousTime = 0;
  private generation = 0;
  private renders = 0;
  private center = new THREE.Vector3();
  private radius = 1;
  private savedAspect?: number;
  private readonly abort = new AbortController();
  private readonly observer: ResizeObserver;
  private readonly intersection: IntersectionObserver;
  private readonly onChange: () => void;
  private readonly onVisibility: () => void;
  private readonly onContextLost: (event: Event) => void;

  constructor(private host: HTMLElement, private changed: (view: ModelObservation) => void, lost: () => void) {
    // Preview is intentionally lightweight, including on high-DPI displays.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "low-power" });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.domElement.setAttribute("aria-label", "3D model preview");
    host.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    // A small neutral environment keeps per-context setup bounded in dual view.
    this.environment = pmrem.fromScene(room, 0.04, 0.1, 100, { size: 64 });
    room.dispose(); pmrem.dispose();
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.6;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 1));
    const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(3, 5, 4); this.scene.add(light);
    this.onChange = () => { this.render(); if (this.gltf) this.changed(this.observation()); };
    this.controls.addEventListener("change", this.onChange);
    this.onVisibility = () => { this.stopFrame(); if (this.visible && !document.hidden) { this.render(); this.schedule(); } };
    document.addEventListener("visibilitychange", this.onVisibility);
    this.onContextLost = event => { event.preventDefault(); this.playing = false; this.stopFrame(); lost(); };
    this.renderer.domElement.addEventListener("webglcontextlost", this.onContextLost);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(host);
    this.intersection = new IntersectionObserver(entries => { this.visible = entries[0].isIntersecting; this.onVisibility(); }); this.intersection.observe(host);
    this.setBackground("dark"); this.resize();
  }

  async load(url: string, restore?: ModelObservation): Promise<PreviewInfo | undefined> {
    const generation = ++this.generation;
    const response = await fetch(url, { signal: this.abort.signal });
    if (!response.ok) throw new Error(`模型资源读取失败 (${response.status})`);
    const bytes = await response.arrayBuffer();
    const report = inspectGlb(bytes);
    if (this.disposed || generation !== this.generation) return;
    const manager = new THREE.LoadingManager();
    // Only loader-created embedded image blob/data URLs can resolve. No network, file or decoder URLs.
    const urls = new Set<string>();
    let failed = false;
    manager.setURLModifier(uri => {
      if (!uri.startsWith("blob:") && !uri.startsWith("data:")) throw new Error("禁止模型外部资源请求");
      if (uri.startsWith("blob:")) { urls.add(uri); if (failed) URL.revokeObjectURL(uri); }
      return uri;
    });
    const textures = new Set<THREE.Texture>(), objects = new Set<THREE.Object3D>(), released = new Set<object>();
    const loader = new GLTFLoader(manager);
    loader.register(parser => {
      const dependency = parser.getDependency.bind(parser);
      parser.getDependency = (type, index) => dependency(type, index).then(value => {
        if (value instanceof THREE.Texture) { textures.add(value); if (failed) releaseObjects([], [value], released); }
        if (value instanceof THREE.Object3D) { objects.add(value); if (failed) releaseObjects([value], [], released); }
        return value;
      });
      return { name: "review-owned-resources" };
    });
    let loaded: GLTF;
    try { loaded = await loader.parseAsync(bytes, ""); }
    catch (error) { failed = true; releaseObjects([...objects], [...textures], released); throw error; }
    finally { for (const url of urls) URL.revokeObjectURL(url); }
    if (this.disposed || generation !== this.generation) { releaseObjects(loaded.scenes); return; }
    if (this.gltf) releaseObjects(this.gltf.scenes);
    this.gltf = loaded; this.scene.add(loaded.scene);
    this.mixer = new THREE.AnimationMixer(loaded.scene);
    loaded.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(loaded.scene, true);
    if (box.isEmpty() || !Number.isFinite(box.max.length()) || box.getSize(new THREE.Vector3()).length() <= 1e-10) throw new Error("默认场景为空或边界为零，无法取景");
    box.getCenter(this.center); this.radius = box.getSize(new THREE.Vector3()).length() / 2;
    // Initial setup changes animation, camera and background together. Render
    // the final state once rather than submitting each intermediate frame.
    this.initializing = true;
    try {
      if (loaded.animations.length) this.setAnimation(0, 0, false);
      this.fit();
      if (restore) this.setView(restore);
    } finally { this.initializing = false; }
    this.render(); this.changed(this.observation());
    const gl = this.renderer.getContext();
    return { ...report, animations: loaded.animations.map((clip, index) => ({ name: clip.name || `Animation ${index + 1}`, duration: clip.duration })),
      bounds: box.getSize(new THREE.Vector3()).toArray(), renderer: String(gl.getParameter(gl.RENDERER)) };
  }

  resize(): void {
    let width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    if (this.savedAspect) { if (width / height > this.savedAspect) width = height * this.savedAspect; else height = width / this.savedAspect; }
    // Bound raster work on large or high-DPI screens without changing layout.
    const pixelRatio = Math.min(1, 512 / Math.max(width, height));
    if (this.renderer.getPixelRatio() !== pixelRatio) this.renderer.setPixelRatio(pixelRatio);

    this.renderer.setSize(width, height); this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.render();
  }
  fit(view: StandardView = "front"): void {
    if (this.gltf) {
      this.gltf.scene.updateMatrixWorld(true);
      this.gltf.scene.traverse(object => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) (object as THREE.SkinnedMesh).skeleton.update(); });
      const box = new THREE.Box3().setFromObject(this.gltf.scene, true);
      box.getCenter(this.center); this.radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
    }
    const directions = { front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0] };
    const distance = this.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.2 / Math.min(1, this.camera.aspect);
    this.camera.up.set(0, view === "top" ? 0 : 1, view === "top" ? -1 : 0);
    this.camera.position.copy(this.center).add(new THREE.Vector3(...directions[view]).multiplyScalar(distance));
    this.camera.near = Math.max(this.radius / 10000, 1e-6); this.camera.far = distance + this.radius * 100;
    this.controls.target.copy(this.center); this.controls.minDistance = this.radius * 0.01; this.controls.maxDistance = distance * 20;
    this.camera.updateProjectionMatrix(); this.controls.update(); this.onChange();
  }
  setBackground(background: "light" | "dark"): void { this.background = background; this.scene.background = new THREE.Color(background === "dark" ? 0x252830 : 0xe9eaed); this.render(); }
  setAnimation(index: number, time: number, playing: boolean): void {
    if (!this.gltf || !this.mixer || !this.gltf.animations[index]) throw new Error("此模型没有所选动画");
    if (index !== this.animationIndex) {
      this.mixer.stopAllAction(); this.animationIndex = index;
      this.action = this.mixer.clipAction(this.gltf.animations[index]); this.action.play();
    }
    this.mixer.setTime(Math.max(0, Math.min(time, this.gltf.animations[index].duration)));
    this.playing = playing; this.stopFrame(); this.render(); this.changed(this.observation()); this.schedule();
  }
  setView(view: ModelObservation): void {
    this.savedAspect = view.viewport.width / view.viewport.height; this.resize();
    if (view.animation) {
      const clip = this.gltf?.animations[view.animation.index];
      if (!clip || (clip.name || `Animation ${view.animation.index + 1}`) !== view.animation.name || view.animation.time > clip.duration) throw new Error("保存的动画观察与此版本不匹配");
      this.setAnimation(view.animation.index, view.animation.time, false);
    }
    this.camera.position.fromArray(view.camera.position); this.camera.quaternion.fromArray(view.camera.quaternion);
    this.controls.target.fromArray(view.camera.target);
    this.camera.up.set(0, 1, 0).applyQuaternion(new THREE.Quaternion().fromArray(view.camera.quaternion));
    this.camera.fov = view.camera.fov; this.camera.near = view.camera.near; this.camera.far = view.camera.far;
    this.setBackground(view.background); this.camera.updateProjectionMatrix(); this.controls.update(); this.onChange();
  }
  linkView(view: ModelObservation, coordinates: boolean): void {
    if (coordinates) { this.setView({ ...view, animation: this.observation().animation }); return; }
    const direction = new THREE.Vector3().fromArray(view.camera.position).sub(new THREE.Vector3().fromArray(view.camera.target)).normalize();
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.copy(this.controls.target).addScaledVector(direction, distance);
    this.camera.up.set(0, 1, 0).applyQuaternion(new THREE.Quaternion().fromArray(view.camera.quaternion));
    this.controls.update(); this.render();
  }
  observation(): ModelObservation {
    const clip = this.gltf?.animations[this.animationIndex];
    return { preset: "neutral-r182-v1", background: this.background,
      camera: { position: this.camera.position.toArray(), quaternion: this.camera.quaternion.toArray(), target: this.controls.target.toArray(), fov: this.camera.fov, near: this.camera.near, far: this.camera.far },
      animation: clip ? { index: this.animationIndex, name: clip.name || `Animation ${this.animationIndex + 1}`, time: this.action?.time ?? 0 } : null,
      viewport: { width: this.renderer.domElement.clientWidth, height: this.renderer.domElement.clientHeight } };
  }
  async capture(size?: { width: number; height: number }): Promise<{ blob: Blob; observation: ModelObservation }> {
    this.playing = false; this.stopFrame(); this.render(true);
    const observation = this.observation(); this.changed(observation);
    if (size) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(size.width, size.height, false);
      this.camera.aspect = size.width / size.height;
      this.camera.updateProjectionMatrix(); this.render(true);
    }
    try {
      const blob = await new Promise<Blob>((resolve, reject) => this.renderer.domElement.toBlob(value => value ? resolve(value) : reject(new Error("截图失败")), "image/png"));
      return { blob, observation };
    } finally { if (size) this.resize(); }
  }
  private render(force = false): void {
    if (this.disposed || (!force && (this.initializing || !this.visible || document.hidden))) return;
    this.renderer.render(this.scene, this.camera);
    this.host.dataset.renderCount = String(++this.renders);
    this.host.dataset.geometries = String(this.renderer.info.memory.geometries);
    this.host.dataset.textures = String(this.renderer.info.memory.textures);
  }
  private stopFrame(): void { cancelAnimationFrame(this.frame); this.frame = 0; this.previousTime = 0; }
  private schedule(): void {
    if (this.frame || !this.playing || this.disposed || !this.visible || document.hidden) return;
    this.frame = requestAnimationFrame(time => {
      this.frame = 0;
      if (this.previousTime) this.mixer!.update(Math.min((time - this.previousTime) / 1000, 0.1));
      this.previousTime = time; this.render(); this.changed(this.observation()); this.schedule();
    });
  }
  dispose(): void {
    this.disposed = true; this.generation++; this.abort.abort(); this.stopFrame();
    this.observer.disconnect(); this.intersection.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.onContextLost);
    this.controls.removeEventListener("change", this.onChange); this.controls.dispose();
    if (this.mixer && this.gltf) { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.gltf.scene); }
    if (this.gltf) releaseObjects(this.gltf.scenes);
    this.environment.dispose(); this.renderer.dispose(); if (!this.renderer.getContext().isContextLost()) this.renderer.forceContextLoss(); this.renderer.domElement.remove();
  }
}
