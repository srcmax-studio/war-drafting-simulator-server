import { Client, ClientMessage, Player } from "./client";
import { Server } from "./server";
import { AuthenticatedEvent, CharactersSyncEvent, EventError, JoinedEvent, StatusEvent } from "./event";
import { Logger } from "./utils";

export abstract class ActionHandler {
    abstract execute(client: Client, data?: any): void;
}

export abstract class PlayerActionHandler {
    abstract execute(player: Player, data?: any): void;
}

export class StatusHandler extends ActionHandler {
    constructor(private server: Server) { super(); }

    execute(client: Client) {
        client.send(new StatusEvent(this.server.getServerState()));
    }
}

export class PongHandler extends PlayerActionHandler {
    execute(player: Player) {
        player.pong();
    }
}

export class RequestCharactersHandler extends PlayerActionHandler {
    constructor(private server: Server) { super(); }

    execute(player: Player) {
        player.send(new CharactersSyncEvent(Array.from(this.server.characters)));
    }
}

export class ChatMessageHandler extends PlayerActionHandler {
    constructor(private server: Server) { super(); }

    execute(player: Player, data?: any) {
        this.server.broadcastMessage(`player.name: ${data.message}`);
    }
}

export class AuthenticateHandler extends ActionHandler {
    constructor(private server: Server) { super(); }

    execute(client: Client, data?: any) {
        const password = data.password?.trim();
        if (!password) {
            throw new EventError("密码不能为空");
        }

        if (password !== this.server.config.password) {
            Logger.warning(`Client ${client.remoteName} failed to authenticate.`)
            throw new EventError("所提供的密码与记录不符")
        }

        client.authenticated = true;
        Logger.info(`Client ${client.remoteName} authenticated.`)
        client.send(new AuthenticatedEvent());
    }
}

export class JoinHandler extends ActionHandler {
    constructor(private server: Server) { super(); }

    execute(client: Client, data: ClientMessage) {
        if (this.server.getServerState().onlinePlayers >= 2) {
            throw new EventError("服务器已满。");
        }

        if (this.server.config.password) {
            if (! client.authenticated) {
                throw new EventError("未通过密码验证。");
            }
        }

        const name = data.name?.trim();
        if (!name) {
            throw new EventError("名字不能为空。");
        } else if (Array.from(this.server.players.values()).some(player => player.name === name)) {
            throw new EventError("此名字已被使用。")
        }

        this.server.players.set(client.ws, new Player(client.ws, name));
        Logger.info(`Client ${client.remoteName} joined as ${name}. (${this.server.getServerState().onlinePlayers}/2)`);

        client.send(new JoinedEvent(this.server.getPlayerNameList(), this.server.getServerState()));
        this.server.broadcastPlayerList();
        this.server.broadcastMessage(`${name} 加入了服务器。`);
    }
}
