// Vitest global setup file. Loaded BEFORE any test module is imported.
// Sets the env vars required for the API to boot in test mode.

// Polyfill DOMMatrix for Node 20 / Linux CI where it is not provided by V8.
// pdfjs-dist (loaded transitively via pdf-parse) references globalThis.DOMMatrix
// at module load time; without this stub the entire test suite crashes with
// "ReferenceError: DOMMatrix is not defined". Fixes #415 (Cluster A).
// @napi-rs/canvas is not a dependency of this repo, so we use a minimal stub
// that covers the properties and methods pdfjs-dist actually calls.
if (typeof globalThis.DOMMatrix === "undefined") {
  class DOMMatrix {
    a: number; b: number; c: number; d: number; e: number; f: number;
    m11: number; m12: number; m13: number; m14: number;
    m21: number; m22: number; m23: number; m24: number;
    m31: number; m32: number; m33: number; m34: number;
    m41: number; m42: number; m43: number; m44: number;
    is2D: boolean; isIdentity: boolean;

    constructor(init?: number[] | string) {
      // Support 6-element [a,b,c,d,e,f] array or no-arg (identity).
      const m = Array.isArray(init) && init.length === 6 ? init : [1, 0, 0, 1, 0, 0];
      this.a = m[0]; this.b = m[1]; this.c = m[2];
      this.d = m[3]; this.e = m[4]; this.f = m[5];
      this.m11 = m[0]; this.m12 = m[1]; this.m13 = 0; this.m14 = 0;
      this.m21 = m[2]; this.m22 = m[3]; this.m23 = 0; this.m24 = 0;
      this.m31 = 0;    this.m32 = 0;    this.m33 = 1; this.m34 = 0;
      this.m41 = m[4]; this.m42 = m[5]; this.m43 = 0; this.m44 = 1;
      this.is2D = true;
      this.isIdentity = (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);
    }

    private _clone(): DOMMatrix {
      return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]);
    }

    // Returns a new DOMMatrix that is the result of this matrix translated by (tx, ty).
    translate(tx: number, ty: number): DOMMatrix {
      const r = this._clone();
      r.e += this.a * tx + this.c * ty;
      r.f += this.b * tx + this.d * ty;
      r.m41 = r.e; r.m42 = r.f;
      return r;
    }

    // Returns a new DOMMatrix that is the result of this matrix scaled by (sx, sy).
    scale(sx: number, sy?: number): DOMMatrix {
      const _sy = sy ?? sx;
      const r = this._clone();
      r.a *= sx; r.b *= sx;
      r.c *= _sy; r.d *= _sy;
      r.m11 = r.a; r.m12 = r.b; r.m21 = r.c; r.m22 = r.d;
      return r;
    }

    // Returns a new DOMMatrix that is the result of multiplying this * other.
    multiply(other: DOMMatrix): DOMMatrix {
      return new DOMMatrix([
        this.a * other.a + this.c * other.b,
        this.b * other.a + this.d * other.b,
        this.a * other.c + this.c * other.d,
        this.b * other.c + this.d * other.d,
        this.a * other.e + this.c * other.f + this.e,
        this.b * other.e + this.d * other.f + this.f,
      ]);
    }

    // Mutates this in place: this = other * this.
    preMultiplySelf(other: DOMMatrix): this {
      const r = other.multiply(this);
      this.a = r.a; this.b = r.b; this.c = r.c; this.d = r.d; this.e = r.e; this.f = r.f;
      this.m11 = r.a; this.m12 = r.b; this.m21 = r.c; this.m22 = r.d; this.m41 = r.e; this.m42 = r.f;
      return this;
    }

    // Mutates this in place: this = this * other.
    multiplySelf(other: DOMMatrix): this {
      const r = this.multiply(other);
      this.a = r.a; this.b = r.b; this.c = r.c; this.d = r.d; this.e = r.e; this.f = r.f;
      this.m11 = r.a; this.m12 = r.b; this.m21 = r.c; this.m22 = r.d; this.m41 = r.e; this.m42 = r.f;
      return this;
    }

    // Mutates this in place to be its own inverse.
    invertSelf(): this {
      const det = this.a * this.d - this.b * this.c;
      if (det === 0) return this;
      const invDet = 1 / det;
      const { a, b, c, d, e, f } = this;
      this.a =  d * invDet;
      this.b = -b * invDet;
      this.c = -c * invDet;
      this.d =  a * invDet;
      this.e = (c * f - d * e) * invDet;
      this.f = (b * e - a * f) * invDet;
      this.m11 = this.a; this.m12 = this.b; this.m21 = this.c; this.m22 = this.d;
      this.m41 = this.e; this.m42 = this.f;
      return this;
    }
  }

  (globalThis as any).DOMMatrix = DOMMatrix;
}

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || "test-jwt-refresh-secret";
process.env.CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

// If the integration test DB URL is provided, route Prisma at it.
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}
