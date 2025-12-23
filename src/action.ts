import { Client, ClientMessage, Player } from "./client";
import { Server } from "./server";
import {
    AuthenticatedEvent,
    CharactersSyncEvent, DraftEvent,
    EventError, GameStartEvent,
    JoinedEvent,
    OpponentHoverEvent, OpponentUnhoverEvent, SelectEvent,
    StatusEvent,
    SyncClockEvent
} from "./event";
import { Logger } from "./utils";
import { DRAFT_STAGE_INIT, DRAFT_STAGE_PASSIVE, DRAFT_STAGE_PASSIVE_DISCARD } from "./common/common";

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
    execute(player: Player, data?: any) {
        player.pong();

        player.send(new SyncClockEvent(data.clientSentAt ?? Date.now()));
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
        this.server.broadcastMessage(`${player.name}: ${data.message}`);
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

        client.send(new JoinedEvent(this.server.getPlayerList(), this.server.getServerState(), name));
        this.server.broadcastPlayerList();
        this.server.broadcastMessage(`${name} 加入了服务器。`);

        if (this.server.reconnectTimeout) {
            const game = this.server.getGame();
            if (this.server.disconnectedPlayer && this.server.disconnectedPlayer.name == name && game && game.lastDraftEvent) {
                clearTimeout(this.server.reconnectTimeout);
                this.server.reconnectTimeout.close();

                this.server.disconnectedPlayer.ws = client.ws;
                this.server.disconnectedPlayer.lastPong = Date.now();

                this.server.players.set(client.ws, this.server.disconnectedPlayer);
                this.server.broadcast(new GameStartEvent(game.getInitiativePlayer().name));

                setTimeout(() => {
                    game.timer?.resume();
                    game.broadcastDecks();
                    this.server.broadcast(<DraftEvent>game.lastDraftEvent);
                }, 1000);

                this.server.broadcastMessage("由于玩家重新连接，对局继续。");
            } else {
                this.server.endGame();
                this.server.broadcastMessage("由于有新的玩家加入，原先的对局已结束。");
            }

            this.server.reconnectTimeout = null;
        }
    }
}

export class ReadyHandler extends PlayerActionHandler {
    constructor(private server: Server) { super(); }

    execute(player: Player) {
        player.ready = true;

        this.server.broadcastPlayerList();
        this.server.broadcastMessage(`${player.name} 准备好了。`);

        const players= this.server.getPlayerList();

        if (players.length < 2) return;
        for (const player of players) if (! player.ready) return;

        this.server.startGame();
        this.server.broadcastMessage("所有玩家准备完成，对局开始。");
    }
}

export class HoverHandler extends PlayerActionHandler {
    execute(player: Player, data: ClientMessage) {
        const opponent = player.getOtherPlayer();
        if (opponent) {
            opponent.send(new OpponentHoverEvent(data.hovering));
        }
    }
}

export class UnhoverHandler extends PlayerActionHandler {
    execute(player: Player) {
        const opponent = player.getOtherPlayer();
        if (opponent) {
            opponent.send(new OpponentUnhoverEvent());
        }
    }
}

export class SelectHandler extends PlayerActionHandler {
    constructor(private server: Server) { super(); }

    execute(player: Player, data: ClientMessage) {
        this.server.broadcast(new SelectEvent(data.selected));
    }
}

export class DecidePassiveDiscardHandler extends PlayerActionHandler {
    constructor(private server: Server) { super(); }

    execute(player: Player, data: ClientMessage) {
        const game = this.server.getGame();
        if (! game ||
            game.getDraftStage() !== DRAFT_STAGE_PASSIVE_DISCARD ||
            game.getInitiativePlayer() === player
        ) return;

        game.clearTimeout();
        game.settlePassiveDiscard(data.discard);
    }
}

export class InitDiscardHandler extends PlayerActionHandler {
    constructor(private server: Server) { super(); }

    execute(player: Player, data: ClientMessage) {
        const game = this.server.getGame();
        if (! game ||
            game.getDraftStage() !== DRAFT_STAGE_INIT ||
            game.getInitiativePlayer() !== player ||
            player.initDiscardRemaining < 1
        ) return;

        player.initDiscardRemaining --;
        game.clearTimeout();
        game.newDraftRound();
    }
}

export class CardSelectHandler extends PlayerActionHandler {
    constructor(private server: Server) { super(); }

    execute(player: Player, data: ClientMessage) {
        const game = this.server.getGame();
        if (! game) return;

        if (game.getDraftStage() === DRAFT_STAGE_INIT) {
            if (player !== game.getInitiativePlayer()) return;

            game.clearTimeout();
            game.settleSelect(player, data.selected, () => game.startPassiveStage());
        }

        if (game.getDraftStage() === DRAFT_STAGE_PASSIVE) {
            if (player !== game.getPassivePlayer()) return;

            game.clearTimeout();
            game.settleSelect(player, data.selected, () => game.newDraftRound());
        }
    }
}

export class SwapPositionAction extends PlayerActionHandler {
    constructor(private server: Server) { super(); }

    execute(player: Player, data: ClientMessage) {
        const game = this.server.getGame();
        if (! game) return;

        player.deck?.switchPositions(data.sourcePos, data.targetPos);
        game.broadcastDecks();
    }
}
