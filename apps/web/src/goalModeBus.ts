// Tiny event bus letting the command palette, the chat.goal key command and
// the dynamic island open or toggle the goal form without owning its React
// state.
const GOAL_COMPOSER_OPEN_EVENT = "dak:open-goal-composer";
const GOAL_COMPOSER_TOGGLE_EVENT = "dak:toggle-goal-composer";

export function openGoalComposer(): void {
  window.dispatchEvent(new CustomEvent(GOAL_COMPOSER_OPEN_EVENT));
}

export function toggleGoalComposer(): void {
  window.dispatchEvent(new CustomEvent(GOAL_COMPOSER_TOGGLE_EVENT));
}

export function onOpenGoalComposer(listener: () => void): () => void {
  window.addEventListener(GOAL_COMPOSER_OPEN_EVENT, listener);
  return () => window.removeEventListener(GOAL_COMPOSER_OPEN_EVENT, listener);
}

export function onToggleGoalComposer(listener: () => void): () => void {
  window.addEventListener(GOAL_COMPOSER_TOGGLE_EVENT, listener);
  return () => window.removeEventListener(GOAL_COMPOSER_TOGGLE_EVENT, listener);
}
