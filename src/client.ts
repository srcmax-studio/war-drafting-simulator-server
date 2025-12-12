import { WebSocket } from "ws";
import { ServerEvent } from "./event";
import { Server } from "./server";

export class Client {
    ws: WebSocket;
    authenticated = false;
    remoteName: string;

    constructor(ws: WebSocket) {
        this.ws = ws;
        // @ts-ignore
        this.remoteName = ws._socket.remoteAddress;
    }

    public send(event: ServerEvent) {
        this.ws.send(event.serialize());
        if (Server.getInstance().config.debug) {
            console.log(`Sent ${event.serialize()} to ${this.remoteName}`)
        }
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

