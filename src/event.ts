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
