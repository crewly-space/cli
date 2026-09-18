export interface Message {
  role: string;
  content: string;
}

export interface Request {
  requestId: string;
  model?: string;
  system?: string;
  messages: Message[];
}

export interface Event {
  type: "delta" | "completed" | "error";
  data?: string;
  error?: Error;
}

export interface Adapter {
  readonly id: string;
  available(): boolean;
  stream(request: Request): AsyncGenerator<Event>;
}
