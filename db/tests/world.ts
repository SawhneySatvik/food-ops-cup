// The world builder lives in the harness (src/world.ts) so every lane's fixtures share one binding-respecting
// builder; db's own gates import it from here.
export { approveDraft, buildWorld, ownerCtx, uuidv7, type World } from "../src/world.ts";
