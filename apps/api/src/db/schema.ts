export interface AccountRecord { id: string; label: string; status: 'available' | 'disabled'; createdAt: string; }
export interface RequestLogRecord { id: string; route: string; model?: string; stream: boolean; createdAt: string; }
