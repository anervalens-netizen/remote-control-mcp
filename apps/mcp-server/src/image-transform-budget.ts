/** Process-wide admission before base64 decoding or native image allocation.
 * There is no pending queue. A cancelled caller cannot release unfinished work. */
export class ImageTransformBudget {
  readonly limit: number;
  private active = 0;
  private highWater = 0;
  private refused = 0;
  private completed = 0;
  constructor(limit = 2) {
    this.limit = limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4) throw new Error("Image transform concurrency must be between 1 and 4");
  }
  acquire(): (() => void) | undefined {
    if (this.active >= this.limit) { this.refused++; return undefined; }
    this.active++; this.highWater = Math.max(this.highWater, this.active);
    let released = false;
    return () => { if (!released) { released = true; this.active--; this.completed++; } };
  }
  stats() {
    return { active: this.active, limit: this.limit, queueLimit: 0, highWater: this.highWater,
      refused: this.refused, completed: this.completed, scope: "controller_process" };
  }
}
export const imageTransforms = new ImageTransformBudget(Number(process.env.RCMCP_IMAGE_TRANSFORM_CONCURRENCY ?? 2));
