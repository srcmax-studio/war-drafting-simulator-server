import { WebSocket } from "ws";
import { PingEvent, ServerEvent } from "./event";
import { Server } from "./server";
import { Logger } from "./utils";
import { PlayerDeck } from "./common/common";

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

export const DISCARD_MAX_INITIATIVE = 5;
export const DISCARD_MAX_PASSIVE = 1;

export class Player extends Client {
    readonly name: string;
    lastPong: number;
    ready: boolean = false;
    initDiscardRemaining = DISCARD_MAX_INITIATIVE;
    passiveDiscardRemaining = DISCARD_MAX_PASSIVE;
    deck: PlayerDeck | null = null;

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

    public hasInitiative(): boolean {
        return Server.getInstance().getGame()?.getInitiativePlayer() === this;
    }

    public getOtherPlayer(): Player {
        return <Player>Server.getInstance().getGame()?.getOtherPlayer(this);
    }
}

export interface ClientMessage {
    action: string;
    [key: string]: any;
}

