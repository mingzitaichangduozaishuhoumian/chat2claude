import type { ClaudeSseEvent } from './types.js';
export function encodeSseEvent(event: ClaudeSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
export function encodeSseEvents(events: ClaudeSseEvent[]): string { return events.map(encodeSseEvent).join(''); }
