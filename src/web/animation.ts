/**
 * The card's stage-local starting point and the folder-mouth landing point.
 */
export type FlightGeometry = { x: number; y: number; targetX: number; targetY: number };

/**
 * Moves from the measured stack to the folder in one continuous arc.
 * A single curve keeps the card moving through its flip, without a peel/hold handoff.
 */
export function flightFrames({ x, y, targetX, targetY }: FlightGeometry): Keyframe[] {
  const dx = targetX - x;

  const bezier = (a: number, b: number, c: number, d: number, t: number) =>
    (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d;

  return Array.from({ length: 65 }, (_, index) => {
    const t = index / 64;
    const left = bezier(x, x + dx * 0.36, targetX, targetX, t);
    const top = bezier(y, y - 80, Math.min(y, targetY) - 100, targetY + 22, t);

    return {
      offset: t,
      transform: `translate3d(${left}px, ${top}px, 0)`,
      opacity: t < 0.92 ? 1 : (1 - t) / 0.08,
    };
  });
}

/**
 * Opens the resting sheet while it travels, with no upright hold or initial pose jump.
 */
export const FLIP_FRAMES: Keyframe[] = [
  {
    offset: 0,
    transform: "perspective(850px) rotateX(87deg) rotateY(0deg) rotateZ(0deg) scale(1)",
  },
  {
    offset: 0.24,
    transform: "perspective(850px) rotateX(0deg) rotateY(-12deg) rotateZ(-2deg) scale(1)",
  },
  {
    offset: 0.6,
    transform: "perspective(850px) rotateX(8deg) rotateY(-28deg) rotateZ(6deg) scale(.83)",
  },
  {
    offset: 0.84,
    transform: "perspective(850px) rotateX(24deg) rotateY(-18deg) rotateZ(3deg) scale(.49)",
  },
  {
    offset: 1,
    transform: "perspective(850px) rotateX(65deg) rotateY(0deg) rotateZ(0deg) scale(.28)",
  },
];

/**
 * Result-driven flights overlap freely; this duration never throttles classification.
 */
export const FLIGHT_MS = 480;
