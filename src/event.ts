import { ServerState } from "./server";

export class EventError extends Error {
    constructor(message?: string) {
        super(message);
    }
}

export abstract class ServerEvent {
    abstract readonly event: string;

    serialize(): string {
        return JSON.stringify(this);
    }
}

export class StatusEvent extends ServerEvent{
    event = 'status';
    title: string;
    owner: string;
    loadedCharacters: number;
    requirePassword: boolean;
    onlinePlayers: number;
    phase: number;

    constructor(serverState: ServerState) {
        super();
        this.title = serverState.title;
        this.owner = serverState.owner;
        this.loadedCharacters = serverState.loadedCharacters;
        this.requirePassword = serverState.requirePassword;
        this.onlinePlayers = serverState.onlinePlayers;
        this.phase = serverState.phase;
    }
}

export class ErrorEvent extends ServerEvent {
    event = 'error';
    message?: string;

    constructor(message?: string) { super(); this.message = message; }
}

export class AuthenticatedEvent extends ServerEvent {
    event = 'authenticated';
}

export class JoinedEvent extends ServerEvent {
    event = "joined";
    constructor(players: string[]) { super(); }
}

export class PlayerListEvent extends ServerEvent {
    event = 'playerlist';
    constructor(players: string[]) { super(); }
}
