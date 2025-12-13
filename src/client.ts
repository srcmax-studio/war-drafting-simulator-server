import { WebSocket } from "ws";
import { PingEvent, ServerEvent } from "./event";
import { Server } from "./server";
import { Logger } from "./utils";

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
            Logger.debug(`Sent ${event.serialize()} to ${this.remoteName}`)
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
    lastPong: number;

    constructor(ws: WebSocket, name: string) {
        super(ws);
        this.name = name;
        this.lastPong = Date.now();
    }

    public pong() {
        this.lastPong = Date.now();
    }

    public ping() {
        this.send(new PingEvent());
    }
}

export interface ClientMessage {
    action: string;
    [key: string]: any;
}

