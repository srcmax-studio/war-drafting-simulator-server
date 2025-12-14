import { ServerState } from "./server";
import { Character } from "./character";

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

export class PingEvent extends ServerEvent {
    event = 'ping';
}

export class MessageEvent extends ServerEvent {
    event = 'message';
    message: string;

    constructor(message: string) { super(); this.message = message; }
}

export class CharactersSyncEvent extends ServerEvent {
    event = 'charactersSync';
    characters: Character[];

    constructor(characters: Character[]) { super(); this.characters = characters; }
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
    players: string[];
    serverState: ServerState;
    playerName: string;
    constructor(players: string[], serverState: ServerState, playerName: string) {
        super();
        this.players = players;
        this.serverState = serverState;
        this.playerName = playerName;
    }
}

export class PlayerListEvent extends ServerEvent {
    event = 'playerlist';
    players: string[];
    constructor(players: string[]) {
        super();
        this.players = players;
    }
}
