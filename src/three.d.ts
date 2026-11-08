// Types for the part of three.js that src/components/VolumeView.tsx uses. @types/three would add seven packages to the
// install, a physics engine among them, for these few classes. Signatures follow @types/three 0.187; when the volume
// view uses more of three, declare it here.
declare module 'three' {
  export const RedFormat: number;
  export const RedIntegerFormat: number;
  export const UnsignedByteType: number;
  export const ShortType: number;
  export const UnsignedShortType: number;
  export const FloatType: number;
  export const NearestFilter: number;
  export const LinearFilter: number;
  export const GLSL3: string;

  export namespace MathUtils {
    function degToRad(degrees: number): number;
  }

  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
    copy(v: Vector3): this;
    clone(): this;
    add(v: Vector3): this;
    sub(v: Vector3): this;
    addScalar(s: number): this;
    addScaledVector(v: Vector3, s: number): this;
    applyMatrix4(m: Matrix4): this;
    project(camera: Camera): this;
    unproject(camera: Camera): this;
    setFromMatrixColumn(m: Matrix4, index: number): this;
    normalize(): this;
    length(): number;
    distanceTo(v: Vector3): number;
    toArray(): [number, number, number];
  }

  export class Matrix4 {
    toArray(): number[];
    set(
      n11: number, n12: number, n13: number, n14: number, n21: number, n22: number, n23: number, n24: number,
      n31: number, n32: number, n33: number, n34: number, n41: number, n42: number, n43: number, n44: number,
    ): this;
    copy(m: Matrix4): this;
    clone(): Matrix4;
    invert(): this;
    determinant(): number;
    multiplyMatrices(a: Matrix4, b: Matrix4): this;
  }

  export class Box3 {
    constructor(min?: Vector3, max?: Vector3);
  }

  export class Object3D {
    position: Vector3;
    up: Vector3;
    matrixWorld: Matrix4;
    frustumCulled: boolean;
    add(...objects: Object3D[]): this;
    lookAt(vector: Vector3): void;
    updateMatrixWorld(force?: boolean): void;
  }

  export class Camera extends Object3D {
    matrixWorldInverse: Matrix4;
    projectionMatrix: Matrix4;
  }

  export class PerspectiveCamera extends Camera {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    fov: number;
    aspect: number;
    updateProjectionMatrix(): void;
  }

  export class Scene extends Object3D {}

  export class BufferGeometry {
    dispose(): void;
  }

  export class PlaneGeometry extends BufferGeometry {
    constructor(width?: number, height?: number);
  }

  export class Material {
    dispose(): void;
  }

  export interface IUniform<T = unknown> {
    value: T;
  }

  export class ShaderMaterial extends Material {
    constructor(parameters?: {
      glslVersion?: string | null;
      uniforms?: Record<string, IUniform>;
      vertexShader?: string;
      fragmentShader?: string;
      depthTest?: boolean;
      depthWrite?: boolean;
    });
  }

  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
  }

  export class Texture {
    format: number;
    type: number;
    internalFormat: string | null;
    minFilter: number;
    magFilter: number;
    unpackAlignment: number;
    set needsUpdate(value: boolean);
    dispose(): void;
  }

  export class Data3DTexture extends Texture {
    constructor(data?: ArrayBufferView | null, width?: number, height?: number, depth?: number);
  }

  export class WebGLRenderer {
    constructor(parameters?: {
      canvas?: HTMLCanvasElement | OffscreenCanvas;
      antialias?: boolean;
      alpha?: boolean;
      powerPreference?: WebGLPowerPreference;
    });
    debug: {
      onShaderError:
        | ((gl: WebGLRenderingContext, program: WebGLProgram, glVertexShader: WebGLShader, glFragmentShader: WebGLShader) => void)
        | null;
    };
    getContext(): WebGLRenderingContext | WebGL2RenderingContext;
    setPixelRatio(value: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    render(scene: Object3D, camera: Camera): void;
    copyTextureToTexture(source: Texture, destination: Texture, sourceRegion?: Box3 | null, destinationPosition?: Vector3 | null): void;
    dispose(): void;
  }
}
