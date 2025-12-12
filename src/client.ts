import { WebSocket } from "ws";
import { ServerEvent } from "./event";

export class Client {
    ws: WebSocket;
    authenticated = false;

    constructor(ws: WebSocket) {
        this.ws = ws;
    }

    public sendRaw(data: any) {
        this.ws.send(JSON.stringify(data));
    }

    public send(event: ServerEvent) {
        this.sendRaw(event);
    }

    public isConnectionActive(): boolean {
        return this.ws.readyState === this.ws.OPEN;
    }

    public is(ws: WebSocket): boolean {
        return this.ws === ws;
    }
}

export class Player extends Client {
    readonly name: string;

    constructor(ws: WebSocket, name: string) {
        super(ws);
        this.name = name;
    }
}

export interface ClientMessage {
    action: string;
    [key: string]: any;
}

