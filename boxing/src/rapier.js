// Rapier (rigid-body physics, compiled to WebAssembly). The WASM is embedded in the module
// and has to be initialised once before anything uses it, so every file imports it from here.
import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();

export default RAPIER;
