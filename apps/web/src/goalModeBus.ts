// Tiny event bus letting the command palette and the chat.goal key command
// open the goal form without owning its React state.
const GOAL_COMPOSER_OPEN_EVENT = "dak:open-goal-composer";

export function openGoalComposer(): void {
  window.dispatchEvent(new CustomEvent(GOAL_COMPOSER_OPEN_EVENT));
}

export function onOpenGoalComposer(listener: () => void): () => void {
  window.addEventListener(GOAL_COMPOSER_OPEN_EVENT, listener);
  return () => window.removeEventListener(GOAL_COMPOSER_OPEN_EVENT, listener);
}
