// Stable stand-in for next-env.d.ts, which `next dev` rewrites to point at its own dist dir (.next/lane-<port>); with
// parallel instances that file names whichever dir started last, so tsconfig excludes it and includes this.
/// <reference types="next" />
/// <reference types="next/image-types/global" />
