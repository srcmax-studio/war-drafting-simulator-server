import { Server, ServerState } from "./server";
import { Player } from "./client";
import { Character, PlayerDeck } from "./common/common";

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

    broadcast() {
        Server.getInstance().broadcast(this);
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

interface IPlayer {
    name: string,
    ready?: boolean,
    initDiscardRemaining?: number,
    passiveDiscardRemaining?: number
}

export class JoinedEvent extends ServerEvent {
    event = "joined";
    players: IPlayer[];
    serverState: ServerState;
    playerName: string;
    constructor(players: Player[], serverState: ServerState, playerName: string) {
        super();
        this.players = players.map(({ name, ready }
        ) => ({ name, ready }));
        this.serverState = serverState;
        this.playerName = playerName;
    }
}

export class SyncClockEvent extends ServerEvent {
    event = 'syncClock';
    serverTime = Date.now();
    clientSentAt: number;
    constructor(clientSentAt: number) {
        super();
        this.clientSentAt = clientSentAt;
    }
}

export class PlayerListEvent extends ServerEvent {
    event = 'playerlist';
    players: IPlayer[];
    constructor(players: Player[]) {
        super();
        this.players = players.map(({ name, ready }
        ) => ({ name, ready }));
    }
}

export class GameStartEvent extends ServerEvent {
    event = 'gameStart';
    initiativePlayer: string;
    constructor(initiativePlayer: string) {
        super();
        this.initiativePlayer = initiativePlayer;
    }
}

export class GameEndEvent extends ServerEvent {
    event = 'gameEnd';
}

export class DraftEvent extends ServerEvent {
    event = 'draft';
    round: number;
    draftStage: number;
    characters: Character[];
    endTime: number;
    initiativePlayer: string;
    players: IPlayer[];
    constructor(round: number, draftStage: number, initiativePlayer: string, characters: Character[], duration: number) {
        super();
        this.round = round;
        this.draftStage = draftStage;
        this.initiativePlayer = initiativePlayer;
        this.characters = characters;
        this.endTime = Date.now() + duration;

        this.players = Server.getInstance().getPlayerList().map(({ name, initDiscardRemaining, passiveDiscardRemaining }
        ) => ({ name, initDiscardRemaining, passiveDiscardRemaining }));
    }
}

export class PlayerDeckUpdateEvent extends ServerEvent {
    event = 'deckUpdate';
    decks: { name: string, data: string }[] = []
    constructor(decks: PlayerDeck[]) {
        super();
        for (const deck of decks) {
            this.decks.push({ name: deck.name, data: deck.serialize() })
        }
    }
}

export class OpponentHoverEvent extends ServerEvent {
    event = 'opponentHover';
    hovering: string;
    constructor(hovering: string) {
        super();
        this.hovering = hovering;
    }
}

export class OpponentUnhoverEvent extends ServerEvent {
    event = 'opponentUnhover';
}

export class SelectEvent extends ServerEvent {
    event = 'select';
    selected: string;
    constructor(selected: string) {
        super();
        this.selected = selected;
    }
}

export class SimulationStartEvent extends ServerEvent {
    event = 'simulationStart';
}

export class SimulationStreamEvent extends ServerEvent {
    event = 'simulationStream';
    text: string;
    constructor(text: string) {
        super();
        this.text = text;
    }
}
