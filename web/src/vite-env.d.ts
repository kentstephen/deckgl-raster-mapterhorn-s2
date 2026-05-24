/// <reference types="vite/client" />

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*?url" {
  const src: string;
  export default src;
}

declare module "@mapbox/martini" {
  export default class Martini {
    constructor(gridSize?: number);
    createTile(terrain: Float32Array | number[]): {
      getMesh(maxError?: number): {
        vertices: Uint16Array;
        triangles: Uint32Array;
      };
    };
  }
}
