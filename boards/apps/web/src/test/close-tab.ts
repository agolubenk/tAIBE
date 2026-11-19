/** Fires `beforeunload`; true when the page asked the browser to confirm. */
export function closeTab() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
