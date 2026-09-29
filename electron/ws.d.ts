declare module "ws" {
  export class WebSocket {
    readonly OPEN: number;
    readonly CLOSED: number;
    readonly readyState: number;
    static readonly OPEN: number;
    static readonly CLOSED: number;
    constructor(url: string, protocols?: string | string[]);
    on(event: "open", listener: () => void): void;
    on(event: "message", listener: (data: Buffer) => void): void;
    on(event: "close", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
    send(data: string, cb?: (err?: Error) => void): void;
    close(): void;
  }
  export default WebSocket;
}
