/**
 * Review timing: when should a scene be prompted to review?
 *
 * `review:last:<scene>` is set when the owner actually looks at the review
 * list (or persists something). A memd-side timer sets `review:pending:<scene>`
 * once the interval elapses, so the next wake-up must show the prompt even if
 * the client missed the exact moment. Pending survives restarts (it lives in
 * the `meta` table).
 */
import { getMeta, setMeta, type Db } from './db.js';

export const REVIEW_LAST_PREFIX = 'review:last:';
export const REVIEW_PENDING_PREFIX = 'review:pending:';

export function lastReviewAt(db: Db, scene: string): number {
  return Number(getMeta(db, `${REVIEW_LAST_PREFIX}${scene}`) ?? 0);
}

/** ISO timestamp since when a reminder is waiting, if one is. */
export function reminderSince(db: Db, scene: string): string | undefined {
  const value = getMeta(db, `${REVIEW_PENDING_PREFIX}${scene}`);
  return value && value.length > 0 ? value : undefined;
}

export function shouldReview(
  db: Db,
  scene: string,
  intervalHours: number,
  hasCandidates: boolean,
  now = Date.now(),
): boolean {
  if (!hasCandidates) return false;
  if (reminderSince(db, scene)) return true;
  return now - lastReviewAt(db, scene) >= intervalHours * 3_600_000;
}

export function markReviewSeen(db: Db, scene: string, now = Date.now()): void {
  setMeta(db, `${REVIEW_LAST_PREFIX}${scene}`, String(now));
  setMeta(db, `${REVIEW_PENDING_PREFIX}${scene}`, '');
}

/** Scenes that currently have at least one live short-term memory. */
export function shortScenes(db: Db, now = Date.now()): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT scene FROM docs
        WHERE stage = 'short' AND scene IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(now) as { scene: string }[];
  return rows.map((row) => row.scene);
}

/**
 * Marks the reminder flag for every scene whose interval elapsed.
 * Idempotent: an existing reminder is left untouched.
 */
export function markScenesNeedingReview(db: Db, intervalHours: number, now = Date.now()): string[] {
  const marked: string[] = [];
  for (const scene of shortScenes(db, now)) {
    if (!shouldReview(db, scene, intervalHours, true, now)) continue;
    if (reminderSince(db, scene)) continue;
    setMeta(db, `${REVIEW_PENDING_PREFIX}${scene}`, new Date(now).toISOString());
    marked.push(scene);
  }
  return marked;
}

/** Background timer; unref'd so tests/processes are not held open. */
export function startReviewScheduler(
  db: Db,
  intervalHours: number,
  onMark?: (scenes: string[]) => void,
): () => void {
  const tick = (): void => {
    try {
      const marked = markScenesNeedingReview(db, intervalHours);
      if (marked.length > 0 && onMark) onMark(marked);
    } catch {
      // A scheduler failure must never crash memd.
    }
  };
  tick();
  const timer = setInterval(tick, 10 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
