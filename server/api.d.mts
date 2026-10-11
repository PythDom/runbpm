import type { IncomingMessage, ServerResponse } from 'node:http';
export function createApi(options: { dataFile: string; navidromeUrl?: string; fetchImpl?: typeof fetch; saveDelayMs?: number }): {
  handle(req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void>;
  flush(): Promise<void>;
  db(): Promise<{ songs: Record<string, unknown>; selections: Record<string, string[]> }>;
};
