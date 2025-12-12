export class EventError extends Error {
    constructor(message: string) {
        super();
    }
}

export abstract class ServerEvent {
    abstract readonly event: string;

    serialize(): string {
        return JSON.stringify(this);
    }
}

export class ErrorEvent extends ServerEvent {
    event = 'error';
    constructor(message?: string) { super(); }
}

export class JoinedEvent extends ServerEvent {
    event = "joined";
    constructor(players: string[]) { super(); }
}
