export interface ChatGptTextDeltaEvent { type: 'text_delta'; text: string; }
export interface ChatGptDoneEvent { type: 'done'; }
export type ChatGptStreamEvent = ChatGptTextDeltaEvent | ChatGptDoneEvent;
