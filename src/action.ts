import { Client, ClientMessage, Player } from "./client";
import { Server } from "./server";
import { EventError, JoinedEvent } from "./event";

export abstract class ActionHandler {
    abstract execute(client: Client, data?: any): void;
}

export abstract class PlayerActionHandler {
    abstract execute(player: Player, data?: any): void;
}

export class StatusHandler implements ActionHandler {
    constructor(private server: Server) {}

    execute(client: Client) {
        client.sendRaw(this.server.serverState);
    }
}

export class JoinHandler implements ActionHandler {
    constructor(private server: Server) {}

    execute(client: Client, data: ClientMessage) {
        if (this.server.serverState.onlinePlayers() >= 2) {
            throw new EventError( "服务器已满");
        }

        const name = data.name?.trim();
        if (!name) {
            throw new EventError("名字不能为空");
        }

        this.server.players.set(client.ws, new Player(client.ws, name));
        console.log(`Player ${name} joined. (${this.server.serverState.onlinePlayers()}/2)`);
        console.log(this.server.players.values())

        let players: string[] = [];
        for (const player of this.server.players.values()) {
            players.push(player.name);
        }
        client.send(new JoinedEvent(players));
        this.server.broadcastStatus();
    }
}
