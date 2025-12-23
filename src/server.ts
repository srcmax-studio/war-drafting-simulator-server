import { WebSocket, WebSocketServer } from "ws";
import { Client, ClientMessage, Player } from "./client";
import axios, { AxiosError } from "axios";
import {
    ActionHandler,
    AuthenticateHandler,
    CardSelectHandler,
    ChatMessageHandler,
    DecidePassiveDiscardHandler,
    HoverHandler,
    InitDiscardHandler,
    JoinHandler,
    PlayerActionHandler,
    PongHandler,
    ReadyHandler,
    RequestCharactersHandler,
    SelectHandler,
    StatusHandler, SwapPositionAction,
    UnhoverHandler
} from "./action";
import { ServerEvent, ErrorEvent, EventError, StatusEvent, PlayerListEvent, MessageEvent, GameEndEvent } from "./event";
import fs from "fs";
import * as https from "node:https";
import { Logger } from "./utils";
import { Game } from "./game";

import { Character } from "./common/common";
import { OpenAI } from "openai";

export interface ServerState {
    title: string,
    owner: string,
    loadedCharacters: number,
    onlinePlayers: number,
    getOnlinePlayers: () => number,
    phase: number,
    requirePassword: boolean,
    tls: boolean
}

const PHASE_LOBBY = 0
const PHASE_DRAFT = 10
const PHASE_SIMULATING = 20

const HEARTBEAT_INTERVAL = 2000;
const HEARTBEAT_TIMEOUT = 5000;

export class Server {
    readonly config;
    readonly characters: Set<Character>;
    private serverState: ServerState;
    clients: Map<WebSocket, Client> = new Map<WebSocket, Client>();
    players: Map<WebSocket, Player> = new Map<WebSocket, Player>();
    private readonly wss: WebSocketServer;
    private actionHandlers: Record<string, ActionHandler | PlayerActionHandler>;
    private static instance: Server;
    private game: Game | null = null;
    ai: OpenAI;

    static getInstance(): Server {
        return this.instance;
    }

    constructor(config: any, characters: Set<Character>) {
        Server.instance = this;
        this.config = config;
        this.characters = characters;

        this.serverState = {
            title: config.title,
            owner: config.owner,
            loadedCharacters: characters.size,
            onlinePlayers: 0,
            getOnlinePlayers: () => { return this.players.size },
            phase: PHASE_LOBBY,
            requirePassword: !!config.password,
            tls: config.tls,
        };

        this.actionHandlers = {
            status: new StatusHandler(this),
            pong: new PongHandler(),
            requestCharacters: new RequestCharactersHandler(this),
            authenticate: new AuthenticateHandler(this),
            join: new JoinHandler(this),
            chatMessage: new ChatMessageHandler(this),
            ready: new ReadyHandler(this),
            hover: new HoverHandler(),
            unhover: new UnhoverHandler(),
            select: new SelectHandler(this),
            decidePassiveDiscard: new DecidePassiveDiscardHandler(this),
            cardSelect: new CardSelectHandler(this),
            initDiscard: new InitDiscardHandler(this),
            swapPosition: new SwapPositionAction(this)
        };

        Logger.info('Starting WebSocket server...');

        this.ai = new OpenAI({
            apiKey: config["openai-api-key"],
            baseURL: config["openai-base-url"],
        });

        let server;
        let options: any = { host: config.host };
        if (this.config.tls) {
            server = https.createServer({
                key: fs.readFileSync(this.config["private-key"]),
                cert: fs.readFileSync(this.config["certificate"])
            });
            options = { ...options, server };
        } else {
            options = { ...options, port: config.port };
            Logger.notice("TLS is NOT enabled. Clients will not be able to connect due to security features on modern browsers when using HTTPS.")
        }

        this.wss = new WebSocketServer(options);
        this.setupWSServer();

        if (this.config.tls) {
            server?.listen(config.port);
        }

        this.setupHeartBeat();

        Logger.info('Listening on ' + config.host + ":" + config.port + ".");
        Logger.info('Server ready!');

        if (this.config["publish-server"]) {
            if (! this.config.tls) {
                if (! this.config["force-publish"]) {
                    Logger.notice("Server will not be published to server list because TLS is not enabled. Use 'force-publish' option to bypass this check.");
                    return;
                } else {
                    Logger.notice("Publish TLS check bypassed. Note that clients will not be able to connect when using HTTPS.")
                }
            }
            this.publish();
        }
    }

    public startGame() {
        for (const player of this.players.values()) {
            player.ready = false;
        }

        this.game = new Game(this);
    }

    public endGame() {
        this.game?.terminate();
        this.game = null;

        this.broadcast(new GameEndEvent());
        this.setPhase(PHASE_LOBBY);
    }

    public getGame() {
        return this.game;
    }

    public getPhase(): number {
        return this.getServerState().phase;
    }

    public setPhase(phase: number) {
        this.getServerState().phase = phase;
    }

    private setupHeartBeat() {
        setInterval(() => {
            const now = Date.now();

            this.players.forEach(player => {
                if (player.ws.readyState === WebSocket.CLOSING) {
                    player.ws.terminate();
                    Logger.info(`Player ${player.name} force terminated after failed close.`);
                    return;
                }

                if (now - player.lastPong > HEARTBEAT_TIMEOUT) {
                    player.ws.close(4001, "由于心跳超时，服务器已关闭连接。");
                    Logger.info(`Player ${player.name} closing due to timeout...`);
                } else {
                    player.ping();
                }
            });
        }, HEARTBEAT_INTERVAL);
    }

    private handle(client: Client, data: ClientMessage) {
        try {
            const handler = this.actionHandlers[data.action];
            if (!handler) {
                console.warn("Unknown action:", data.action);
                return;
            }

            if (handler instanceof PlayerActionHandler) {
                const player = this.players.get(client.ws);
                if (!player) {
                    client.send(new ErrorEvent('Unauthenticated.'));
                    return;
                }

                handler.execute(player, data);
            } else {
                handler.execute(client, data);
            }
        } catch (e) {
            if (e instanceof EventError) {
                client.send(new ErrorEvent(e.message));
            } else {
                console.error("Invalid message", e);
            }
        }
    }

    private setupWSServer() {
        this.wss.on('connection', (ws, req) => {
            const client = new Client(ws);
            this.clients.set(ws, client);

            ws.on('close', () => {
                this.clients.delete(ws);
                if (this.players.has(ws)) {
                    const player = this.players.get(ws);

                    Logger.info(`Player ${player?.name} left. (${(this.getServerState().onlinePlayers-1)}/2)`);
                    this.players.delete(ws);
                    this.broadcastPlayerList();
                    this.broadcastMessage(`${player?.name} 退出了服务器。`);

                    if (this.game && this.getPhase() !== PHASE_LOBBY) {
                        this.endGame();
                        this.broadcastMessage("由于有玩家中途退出，对局结束。");
                    }
                }
            });

            ws.on('message', (rdata) => {
                if (this.config.debug) {
                    Logger.debug(`Received ${rdata.toString()} from ${client.remoteName}`);
                }

                let message;
                try {
                    message = JSON.parse(rdata.toString());
                } catch (e) {
                    client.send(new ErrorEvent("Malformed request."));
                    return;
                }

                this.handle(client, message);
            });

            client.send(new StatusEvent(this.getServerState()));
        });
    }

    public getPlayerList(): Player[] {
        let players = [];
        for (const player of this.players.values()) {
            players.push(player);
        }

        return players;
    }

    public broadcastPlayerList() {
        this.broadcast(new PlayerListEvent(this.getPlayerList()));
    }

    public broadcast(event: ServerEvent) {
        for (const player of this.players.values()) {
            if (player.isConnectionActive()) {
                player.send(event);
            }
        }
    }

    public broadcastMessage(message: string) {
        this.broadcast(new MessageEvent(message));
    }

    public getServerState() {
        this.serverState.onlinePlayers = this.serverState.getOnlinePlayers();
        return this.serverState;
    }

    private async publish() {
        Logger.info("Publishing server to " + this.config["publish-endpoint"]);

        try {
            const res = await axios.post(
                this.config["publish-endpoint"],
                { ip: this.config["publish-address"], port: this.config.port, tls: this.config.tls },
            );
            if (res.data.ok) {
                Logger.info("Server published to public server list.");
            } else {
                throw new Error("unknown error");
            }
        } catch (e) {
            console.error("Failed to publish to public server list: ",
                e instanceof AxiosError
                    ? e.response?.data : "unknown error");
            console.error("Please confirm publish-address is set to a domain name pointing to your public IP address and the certificate is valid.")
        }
    }
}
