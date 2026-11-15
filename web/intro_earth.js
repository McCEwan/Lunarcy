// The Earth hanging to the left of the Moon on the opening screens (decoration only).
// Its own small three.js canvas, so it never touches the globe's scene. Textures: NASA Blue
// Marble (day) and city lights (night), via the three-globe example images on jsDelivr.
import * as THREE from 'three';

const TEX = 'https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/';

export function startIntroEarth(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 4.4);

  const loader = new THREE.TextureLoader();
  const load = (f) => {
    const t = loader.load(TEX + f);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  // Sunlight from the right and slightly in front, like the light that is reaching the Moon.
  const sunDir = new THREE.Vector3(1, 0.25, 0.55).normalize();
  const earthMat = new THREE.ShaderMaterial({
    uniforms: { day: { value: load('earth-blue-marble.jpg') }, night: { value: load('earth-night.jpg') }, sunDir: { value: sunDir } },
    vertexShader: `
      varying vec2 vUv; varying vec3 vN;
      void main() {
        vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D day; uniform sampler2D night; uniform vec3 sunDir;
      varying vec2 vUv; varying vec3 vN;
      void main() {
        float l = dot(normalize(vN), sunDir);
        float dayMix = smoothstep(-0.12, 0.18, l);
        vec3 d = texture2D(day, vUv).rgb * (0.25 + 1.05 * max(l, 0.0));
        vec3 n = texture2D(night, vUv).rgb * 1.3;
        gl_FragColor = vec4(mix(n, d, dayMix), 1.0);
      }`,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), earthMat);
  earth.rotation.z = 0.41;                    // axial tilt, 23.4°
  scene.add(earth);

  // Thin blue atmosphere: a slightly larger shell, bright at the rim, on the lit side.
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(1.06, 64, 32),
    new THREE.ShaderMaterial({
      uniforms: { sunDir: { value: sunDir } },
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: `
        uniform vec3 sunDir; varying vec3 vN; varying vec3 vV;
        void main() {
          float rim = pow(1.0 - abs(dot(vN, vV)), 3.0);
          float lit = smoothstep(-0.3, 0.4, dot(vN, sunDir));
          gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * rim * lit * 1.6, rim * lit);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
    }),
  );
  scene.add(glow);

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  let running = true;
  const tick = () => {
    if (!running) return;
    earth.rotation.y += 0.0012;
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return function stop() {
    running = false;
    window.removeEventListener('resize', resize);
    renderer.dispose();
    renderer.domElement.remove();
  };
}
