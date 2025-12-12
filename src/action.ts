import { Client, ClientMessage, Player } from "./client";
import { Server } from "./server";
import { AuthenticatedEvent, EventError, JoinedEvent } from "./event";

export abstract class ActionHandler {
    abstract execute(client: Client, data?: any): void;
}

export abstract class PlayerActionHandler {
    abstract execute(player: Player, data?: any): void;
}

export class StatusHandler implements ActionHandler {
    constructor(private server: Server) {}

    execute(client: Client) {
        client.sendRaw(this.server.getServerState());
    }
}

export class AuthenticateHandler implements ActionHandler {
    constructor(private server: Server) {}

    execute(client: Client, data?: any) {
        const password = data.password?.trim();
        if (!password) {
            throw new EventError("密码不能为空");
        }

        if (password !== this.server.config.password) {
            console.log(`Client ${client.remoteName} failed to authenticate.`)
            throw new EventError("所提供的密码与记录不符")
        }

        client.authenticated = true;
        console.log(`Client ${client.remoteName} authenticated.`)
        client.send(new AuthenticatedEvent());
    }
}

export class JoinHandler implements ActionHandler {
    constructor(private server: Server) {}

    execute(client: Client, data: ClientMessage) {
        if (this.server.getServerState().onlinePlayers >= 2) {
            throw new EventError("服务器已满");
        }

        if (this.server.config.password) {
            if (! client.authenticated) {
                throw new EventError("未通过密码验证");
            }
        }

        const name = data.name?.trim();
        if (!name) {
            throw new EventError("名字不能为空");
        }

        this.server.players.set(client.ws, new Player(client.ws, name));
        console.log(`Client ${client.remoteName} joined as ${name}. (${this.server.getServerState().onlinePlayers}/2)`);

        let players: string[] = [];
        for (const player of this.server.players.values()) {
            players.push(player.name);
        }
        client.send(new JoinedEvent(players));
        this.server.broadcastStatus();
    }
}
