/**
 * One ordering for DAK's simultaneous live activities. The island renders the
 * first two as its split presentation; further activities remain registered
 * and surface as higher-priority entries finish. Leave gaps for future states.
 */
export const islandActivityPriority = {
  plan: 10,
  feedback: 40,
  desktopUpdate: 50,
  notification: 60,
  goal: 70,
  goalAttention: 90,
  needsInput: 100,
} as const;
