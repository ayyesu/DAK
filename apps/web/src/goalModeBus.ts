// Tiny event bus letting the command palette and the chat.goal key command
// open the goal form without owning its React state.
const GOAL_COMPOSER_OPEN_EVENT = "dak:open-goal-composer";
const GOAL_WORK_OPEN_EVENT = "dak:open-goal-work";

export function openGoalComposer(): void {
  window.dispatchEvent(new CustomEvent(GOAL_COMPOSER_OPEN_EVENT));
}

export function onOpenGoalComposer(listener: () => void): () => void {
  window.addEventListener(GOAL_COMPOSER_OPEN_EVENT, listener);
  return () => window.removeEventListener(GOAL_COMPOSER_OPEN_EVENT, listener);
}

/** Opens the optional goal-work surface after navigating to its owning thread. */
export function openGoalWork(goalId: string): void {
  window.dispatchEvent(new CustomEvent<string>(GOAL_WORK_OPEN_EVENT, { detail: goalId }));
}

export function onOpenGoalWork(listener: (goalId: string) => void): () => void {
  const onOpen = (event: Event) => listener((event as CustomEvent<string>).detail);
  window.addEventListener(GOAL_WORK_OPEN_EVENT, onOpen);
  return () => window.removeEventListener(GOAL_WORK_OPEN_EVENT, onOpen);
}
